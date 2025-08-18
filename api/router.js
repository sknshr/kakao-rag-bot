// api/router.js
// ---------------------------------------------------------------------------
// ✅ Vercel 서버리스에서 동작하는 메인 라우터
//  - /           : 헬스체크(간단 OK 문구)
//  - /upload     : 관리자 PDF 업로드 → 텍스트화 → 청크 → 임베딩 → Supabase 저장
//  - /kakao(GET/POST) : 카카오 스킬 웹훅 (fast=1 테스트, 헤더/쿼리 시크릿 검증 지원)
// ---------------------------------------------------------------------------

import express from "express";
import multer from "multer";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import serverless from "serverless-http";

// --------------------------------------------------------------------------------------
// 1) 기본 설정
// --------------------------------------------------------------------------------------
const app = express();

app.use((req, res, next) => {
  console.log("[IN]", req.method, req.url, "q=", req.query);
  next();
});

// JSON 파서: 일부 클라이언트가 Content-Type을 정확히 안 주는 경우를 대비해 type="*/*"
app.use(express.json({ limit: "5mb" }));
// 파일 업로드: 서버리스는 디스크가 없으므로 메모리 저장 권장
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB
});

// 환경변수
const {
  OPENAI_API_KEY,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  ADMIN_PASSWORD,
  KAKAO_SKILL_SECRET
} = process.env;

// OpenAI / Supabase 클라이언트 헬퍼
function getOpenAI() {
  if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");
  return new OpenAI({ apiKey: OPENAI_API_KEY });
}
function getSupabase() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
}

// --------------------------------------------------------------------------------------
// 2) 유틸 함수
// --------------------------------------------------------------------------------------

// (중요) PDF → 텍스트: 무거운 pdfjs-dist는 '필요할 때만' 동적 import (콜드스타트 단축)
async function pdfBufferToText(buffer) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const pdf = await pdfjs.getDocument({ data: buffer }).promise;
  let text = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map(it => it.str).join(" ") + "\n";
    // 너무 큰 PDF 보호용: 2MB 정도에서 컷
    if (text.length > 2_000_000) break;
  }
  return text;
}

// 긴 텍스트 → 잘게 쪼개기(청크)
function chunkText(text, chunkSize = 1200, overlap = 200) {
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    const end = Math.min(i + chunkSize, text.length);
    chunks.push(text.slice(i, end));
    i = end - overlap;
    if (i < 0) i = 0;
  }
  return chunks;
}

// OpenAI 임베딩
async function embed(openai, texts) {
  const r = await openai.embeddings.create({
    model: "text-embedding-3-large", // 3072차원
    input: texts
  });
  return r.data.map(d => d.embedding);
}

// Supabase 벡터 검색(RPC 함수 사용)
async function searchDocs(openai, supabase, query, filterSource = null, topK = 5) {
  const [qEmbed] = await embed(openai, [query]);
  const { data, error } = await supabase.rpc("match_documents", {
    query_embedding: qEmbed,
    match_count: topK,
    filter_source: filterSource
  });
  if (error) throw error;
  return data || [];
}

// 마스터 에이전트: 어떤 에이전트를 우선 쓸지 간단 판별
function pickAgent(userText) {
  const t = (userText || "").toLowerCase();
  const company = ["취업규칙","단체협약","임금협약","연차","휴가","특별휴가","수당","교대","승진","밴드"];
  const law = ["근로기준법","연차유급휴가","해고","서면통지","고용보험","산재","유연근무","출산휴가","육아휴직"];
  if (company.some(k => t.includes(k))) return "company";
  if (law.some(k => t.includes(k))) return "law";
  return "mix";
}

// 회사 내규 에이전트
async function agentCompany(openai, supabase, q) {
  const hits = await searchDocs(openai, supabase, q, "회사취업규칙").catch(()=>[]);
  const more1 = hits.length<3 ? await searchDocs(openai, supabase, q, "단체협약").catch(()=>[]) : [];
  const more2 = hits.length+more1.length<3 ? await searchDocs(openai, supabase, q, "임금협약서").catch(()=>[]) : [];
  return { name: "회사 내규", contexts: [...hits, ...more1, ...more2] };
}

// 법령 기준 에이전트
async function agentLaw(openai, supabase, q) {
  const pool = ["근로기준법","고용보험법","산재보험법","유연근무매뉴얼","노무관리가이드북","질의회시집","양성평등기본법"];
  let ctx = [];
  for (const src of pool) {
    const got = await searchDocs(openai, supabase, q, src).catch(()=>[]);
    ctx = ctx.concat(got);
    if (ctx.length>6) break;
  }
  return { name: "법령 기준", contexts: ctx.slice(0,6) };
}

// LLM으로 최종 답안 생성
async function answerWithLLM(openai, userText, bundles) {
  const system = `당신은 HR/노무 챗봇입니다. 회사규정→법령 순으로 근거를 들어 간결히 답하세요. 핵심 bullet, 마지막에 "주의/근거" 2~3줄. 한국어.`;
  const ctx = bundles.flatMap(b => b.contexts)
    .map(c => `【${c.source}/${c.title}】 ${String(c.content || "").slice(0,500)}`)
    .join("\n\n");
  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: system },
      { role: "user", content: `[사용자 질문]\n${userText}\n\n[검색된 근거]\n${ctx}` }
    ],
    temperature: 0.2
  });
  return res.choices[0]?.message?.content?.trim() || "답변 생성 실패";
}

// 안전 타임아웃 래퍼(LLM이 느릴 때 임시 문구라도 반환)
const withTimeout = (p, ms, fallback) =>
  Promise.race([p, new Promise(resolve => setTimeout(() => resolve(fallback), ms))]);

// --------------------------------------------------------------------------------------
// 3) 라우트
// --------------------------------------------------------------------------------------

// 헬스체크
app.get("/", (req, res) => res.status(200).send("OK - kakao-rag-bot"));

// (가벼운 버전의 /admin 화면은 api/admin.js에서 처리하는 것을 권장합니다.)
// 이 파일에 /admin 라우트를 넣지 않아도 됩니다. (vercel.json에서 /admin → /api/admin.js 라우팅)

// PDF 업로드(관리자 전용)
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    const { pw, source = "기타", title = "문서" } = req.body || {};
    if (pw !== ADMIN_PASSWORD) return res.status(403).send("비밀번호 오류");
    if (!req.file?.buffer) return res.status(400).send("파일이 없습니다.");

    const openai = getOpenAI();
    const supabase = getSupabase();

    // 1) PDF → 텍스트
    const fullText = await pdfBufferToText(req.file.buffer);

    // 2) 청크 분할
    const chunks = chunkText(fullText);

    // 3) 임베딩 생성
    const embeddings = await embed(openai, chunks);

    // 4) DB 저장 (documents 테이블: source/title/page/content/metadata/embedding)
    const rows = chunks.map((content, i) => ({
      source, title, page: null, content, metadata: {}, embedding: embeddings[i]
    }));

    const { error } = await supabase.from("documents").insert(rows);
    if (error) throw error;

    res.send("업로드/인덱싱 완료!");
  } catch (e) {
    console.error(e);
    res.status(500).send("업로드 실패: " + e.message);
  }
});

// 카카오 스킬 웹훅 (GET/POST 모두 허용 + fast 테스트 + 헤더/쿼리 시크릿)
const kakaoHandler = async (req, res) => {
  try {
    // fast 쿼리 있으면 시크릿도 건너뛰고 즉시 응답
    if (typeof req.query.fast !== "undefined") {
      console.log("HIT /kakao?fast", req.method, req.query);
      return res.json({
        version: "2.0",
        template: { outputs: [ { simpleText: { text: "pong(fast-debug)" } } ] }
      });
    }
    // 1) 시크릿 검증: 헤더(x-skill-secret) 또는 쿼리(?secret=)
    if (KAKAO_SKILL_SECRET) {
      const token = req.headers["x-skill-secret"] || req.query.secret;
      if (token !== KAKAO_SKILL_SECRET) {
        return res.status(403).json({ error: "forbidden" });
      }
    }

    // 2) 초고속 테스트 모드: Test URL에 ?fast=1 붙이면 즉시 응답
    if (req.query.fast === "1") {
      return res.json({
        version: "2.0",
        template: {
          outputs: [{ simpleText: { text: "pong(테스트) — 서버 연결 정상입니다." } }]
        }
      });
    }

    // 3) 본 처리
    const openai = getOpenAI();
    const supabase = getSupabase();

    const userText = req.body?.userRequest?.utterance || "";
    const userId = req.body?.userRequest?.user?.id || "anon";

    const mode = pickAgent(userText);
    const company = await agentCompany(openai, supabase, userText);
    const law = await agentLaw(openai, supabase, userText);
    const bundles = mode === "company" ? [company] : mode === "law" ? [law] : [company, law];

    // LLM 응답(4.5초 안전망)
    const finalText = await withTimeout(
      answerWithLLM(openai, userText, bundles),
      4500,
      "잠시만요, 답변 정리 중입니다. 곧 이어서 알려드릴게요."
    );

    // 4) Q&A 메모리 저장 (실패해도 서비스에는 영향 X)
    try {
      const [qEmbed] = await embed(openai, [userText || "(empty)"]);
      await getSupabase()
        .from("qa_memory")
        .insert({ user_id: userId, question: userText, answer: finalText, embedding: qEmbed });
    } catch (e) {
      console.warn("qa_memory save warn:", e.message);
    }

    // 5) 카카오 스킬 포맷으로 응답
    return res.json({
      version: "2.0",
      template: {
        outputs: [{ simpleText: { text: String(finalText).slice(0, 2500) } }],
        quickReplies: [
          { label: "회사규정으로 다시", action: "message", messageText: "회사 규정 기준으로 다시 알려줘" },
          { label: "법 기준으로 다시", action: "message", messageText: "법 기준으로 다시 알려줘" }
        ]
      }
    });
  } catch (e) {
    console.error(e);
    // 카카오 포맷으로 에러 응답
    return res.json({
      version: "2.0",
      template: {
        outputs: [{ simpleText: { text: "잠시 오류가 발생했어요. 조금 뒤 다시 시도해 주세요." } }]
      }
    });
  }
};
app.get("/kakao/ping", (req, res) => {
  res.json({ version: "2.0", template: { outputs: [ { simpleText: { text: "pong" } } ] } });
});

app.get("/kakao", (req, res) => {
  res.json({ version: "2.0", template: { outputs: [ { simpleText: { text: "ok get /kakao" } } ] } });
});

app.post("/kakao", (req, res) => {
  res.json({ version: "2.0", template: { outputs: [ { simpleText: { text: "ok post /kakao" } } ] } });
});

// GET/POST 모두 허용 (오픈빌더 테스트가 GET일 때 대비)
app.post("/kakao", kakaoHandler);
app.get("/kakao", kakaoHandler);
// --------------------------------------------------------------------------------------
// 4) Vercel 서버리스 내보내기
// --------------------------------------------------------------------------------------
export default serverless(app);
