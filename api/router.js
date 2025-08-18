// api/router.js — 서버리스 순수 핸들러 버전 (Express 미사용)
// 기능: /kakao(POST) 답변 생성, /upload(POST) PDF 업로드+임베딩, /kakao/ping, /kakao?fast

import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import Busboy from "busboy";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const {
  OPENAI_API_KEY,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  KAKAO_SKILL_SECRET,
  ADMIN_PASSWORD
} = process.env;

// --------- 공통 유틸 ---------
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function kakaoText(text, quickReplies = []) {
  return {
    version: "2.0",
    template: { outputs: [{ simpleText: { text } }], quickReplies }
  };
}

function chunkText(text, chunkSize = 1100, overlap = 150) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const end = Math.min(i + chunkSize, text.length);
    out.push(text.slice(i, end));
    i = end - overlap;
    if (i < 0) i = 0;
  }
  return out;
}

async function embed(texts) {
  const r = await openai.embeddings.create({
    model: "text-embedding-3-small", // 1536차원, 저렴
    input: texts
  });
  return r.data.map(d => d.embedding);
}

async function pdfBufferToText(buffer) {
  const pdf = await getDocument({ data: buffer }).promise;
  let text = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map(it => it.str).join(" ") + "\n";
    if (text.length > 2_000_000) break; // 안전 가드
  }
  return text.trim();
}

async function searchDocs(query, filterSource = null, topK = 5) {
  const [qEmbed] = await embed([query]);
  const { data, error } = await supabase.rpc("match_documents", {
    query_embedding: qEmbed,
    match_count: topK,
    filter_source: filterSource
  });
  if (error) throw error;
  return data || [];
}

function pickAgent(userText) {
  const t = (userText || "").toLowerCase();
  const company = ["취업규칙","단체협약","임금협약","연차","휴가","특별휴가","수당","교대","승진","근태","포상","징계"];
  const law = ["근로기준법","연차유급휴가","해고","서면통지","고용보험","산재","유연근무","출산휴가","육아휴직","평등","성희롱"];
  if (company.some(k => t.includes(k))) return "company";
  if (law.some(k => t.includes(k))) return "law";
  return "mix";
}

async function answerWithLLM(userText, bundles) {
  const system = `당신은 한국 기업 HR/노무 챗봇입니다. 검색 근거(회사규정→법령 순)를 활용해 한국어로 간결+정확하게 답하세요. 핵심 bullet과 마지막에 '주의/근거' 2~3줄.`;
  const ctx = bundles.flatMap(b => b.contexts)
    .map(c => `【${c.source}/${c.title}】 ${String(c.content || "").slice(0, 600)}`)
    .join("\n\n");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4500); // 4.5초 가드

  try {
    const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: system },
        { role: "user", content: `[사용자 질문]\n${userText}\n\n[검색된 근거]\n${ctx}` }
      ],
      temperature: 0.2,
      signal: controller.signal
    });
    clearTimeout(timer);
    return res.choices[0]?.message?.content?.trim() || "답변 생성 실패";
  } catch (e) {
    clearTimeout(timer);
    return "요청이 많아 잠시 후 다시 시도해 주세요. (LLM 타임아웃)";
  }
}

// --------- 메인 핸들러 ---------
export default async function handler(req, res) {
  try {
    const host = req.headers.host || "localhost";
    const url = new URL(req.url, `http://${host}`);
    const pathname = url.pathname;
    const q = url.searchParams;

    // 0) 핑 & 디버그
    if (pathname === "/kakao/ping") {
      return res.status(200).json(kakaoText("pong"));
    }
    if (pathname === "/kakao" && (q.has("fast") || q.get("fast") === "1")) {
      return res.status(200).json(kakaoText("pong(fast-debug)"));
    }

    // 1) 업로드 (multipart/form-data) — vercel.json에서 /upload → 이 파일로 라우팅됨
    if (pathname === "/upload" && req.method === "POST") {
      if (ADMIN_PASSWORD) {
        // 간단 필드검사 위해 stream 전에 헤더만 보고 진행
      }
      const bb = Busboy({ headers: req.headers });
      let fileBuffer = null;
      const fields = {};

      bb.on("file", (_name, file, info) => {
        const chunks = [];
        file.on("data", d => chunks.push(d));
        file.on("end", () => { fileBuffer = Buffer.concat(chunks); });
      });
      bb.on("field", (name, val) => { fields[name] = val; });

      bb.on("close", async () => {
        try {
          const { pw, source = "기타", title = "문서" } = fields;
          if (ADMIN_PASSWORD && pw !== ADMIN_PASSWORD) {
            return res.status(403).send("비밀번호 오류");
          }
          if (!fileBuffer) return res.status(400).send("파일이 없습니다.");

          const fullText = await pdfBufferToText(fileBuffer);
          const chunks = chunkText(fullText);
          const embeddings = await embed(chunks);

          const rows = chunks.map((content, i) => ({
            source, title, page: null, content, metadata: {}, embedding: embeddings[i]
          }));

          const { error } = await supabase.from("documents").insert(rows);
          if (error) throw error;

          return res.status(200).send("업로드/인덱싱 완료!");
        } catch (e) {
          console.error("upload error:", e);
          return res.status(500).send("업로드 실패: " + e.message);
        }
      });

      req.pipe(bb);
      return; // 스트림 종료 콜백에서 응답함
    }

    // 2) 카카오 웹훅
    if (pathname === "/kakao") {
      // 시크릿 검증
      if (KAKAO_SKILL_SECRET) {
        const token = req.headers["x-skill-secret"] || q.get("secret");
        if (token !== KAKAO_SKILL_SECRET) {
          return res.status(403).json({ error: "forbidden" });
        }
      }

      if (req.method === "GET") {
        return res.status(200).json(
          kakaoText("카카오 웹훅 OK (GET). 테스트는 POST로 보내주세요.")
        );
      }

      if (req.method === "POST") {
        // JSON 본문 읽기
        const buffers = [];
        for await (const chunk of req) buffers.push(chunk);
        const raw = Buffer.concat(buffers).toString("utf8");
        let body = {};
        try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }

        const userText = body?.userRequest?.utterance || "";
        const userId = body?.userRequest?.user?.id || "anon";

        // 2-1) 마스터 에이전트 → 컨텍스트 구성
        const mode = pickAgent(userText);
        let bundles = [];

        if (mode === "company") {
          const a = await searchDocs(userText, "회사취업규칙", 4).catch(()=>[]);
          const b = await searchDocs(userText, "단체협약", 3).catch(()=>[]);
          const c = await searchDocs(userText, "임금협약서", 3).catch(()=>[]);
          bundles = [{ name:"회사 내규", contexts:[...a, ...b, ...c] }];
        } else if (mode === "law") {
          const pool = ["근로기준법","고용보험법","산업재해보상보험법","유연근무매뉴얼","노무관리가이드북","질의회시집","양성평등기본법"];
          let ctx = [];
          for (const src of pool) {
            const got = await searchDocs(userText, src, 2).catch(()=>[]);
            ctx = ctx.concat(got);
            if (ctx.length > 6) break;
          }
          bundles = [{ name:"법령 기준", contexts: ctx.slice(0,6) }];
        } else {
          // mix
          const comp = await searchDocs(userText, "회사취업규칙", 3).catch(()=>[]);
          const law = await searchDocs(userText, null, 3).catch(()=>[]);
          bundles = [{ name:"회사 내규", contexts: comp }, { name:"법령 기준", contexts: law }];
        }

        // 2-2) LLM 답변
        const finalText = await answerWithLLM(userText, bundles);

        // 2-3) 저장(선택)
        try {
          const [qEmbed] = await embed([userText]);
          await supabase.from("documents") // 저장 테이블 따로 쓰고 싶으면 qa_memory 등으로 교체
            .insert([{ source:"qa_memory", title: userId, page:null, content: finalText, metadata:{ q:userText }, embedding: qEmbed }]);
        } catch (e) { /* ignore */ }

        const quick = [
          { label:"회사규정으로", action:"message", messageText:"회사 규정 기준으로 다시 알려줘" },
          { label:"법 기준으로",  action:"message", messageText:"법 기준으로 다시 알려줘" }
        ];
        return res.status(200).json(kakaoText(finalText, quick));
      }

      return res.status(405).json({ error: "method-not-allowed" });
    }

    // 3) 그 외
    return res.status(404).json({ error: "not-found", path: pathname });
  } catch (e) {
    console.error("router error:", e);
    return res.status(500).json({ error: "router-failed", message: String(e) });
  }
}
