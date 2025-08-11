// api/index.js — pdfjs-dist 버전 (서버리스 친화, 크래시 방지)
import express from "express";
import multer from "multer";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import serverless from "serverless-http";
// ✅ pdf-parse 대신 pdfjs-dist 사용 (Node에서는 워커 설정 불필요)
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const app = express();
app.use(express.json({ limit: "5mb" }));
const upload = multer({ limits: { fileSize: 50 * 1024 * 1024 } });

const {
  OPENAI_API_KEY,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  ADMIN_PASSWORD,
  KAKAO_SKILL_SECRET
} = process.env;

// --- lazy 생성(ENV 누락 시 즉시 크래시 방지) ---
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

// 헬스체크
app.get("/", (req, res) => res.status(200).send("OK - kakao-rag-bot"));

// 간단 업로드 폼
app.get("/admin", (req, res) => {
  res.send(`
    <h3>PDF 업로드(관리자)</h3>
    <form action="/upload" method="post" enctype="multipart/form-data">
      <p><input type="password" name="pw" placeholder="ADMIN_PASSWORD" /></p>
      <p><input type="text" name="source" placeholder="문서출처(예: 회사취업규칙/근로기준법)" /></p>
      <p><input type="text" name="title" placeholder="문서제목(파일명)" /></p>
      <p><input type="file" name="file" /></p>
      <button>업로드</button>
    </form>
  `);
});

// --- PDF → 텍스트 추출 (pdfjs-dist 사용) ---
async function pdfBufferToText(buffer) {
  const loadingTask = getDocument({ data: buffer });
  const pdf = await loadingTask.promise;
  let text = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    // item.str들만 모아 한 줄로
    text += content.items.map(it => it.str).join(" ") + "\n";
    // 서버리스 타임아웃 방지용(아주 큰 PDF는 나눠 업로드 권장)
    if (text.length > 2_000_000) break; // 2MB 텍스트면 충분
  }
  return text;
}

// 텍스트 청크
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

// 임베딩
async function embed(openai, texts) {
  const r = await openai.embeddings.create({
    model: "text-embedding-3-large",
    input: texts
  });
  return r.data.map(d => d.embedding);
}

// 업로드 + 인덱싱
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    const { pw, source = "기타", title = "문서" } = req.body;
    if (pw !== ADMIN_PASSWORD) return res.status(403).send("비밀번호 오류");
    if (!req.file?.buffer) return res.status(400).send("파일이 없습니다.");

    const openai = getOpenAI();
    const supabase = getSupabase();

    const fullText = await pdfBufferToText(req.file.buffer);
    const chunks = chunkText(fullText);
    const embeddings = await embed(openai, chunks);
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

// --- 검색/에이전트/QA 저장 (기존 로직 그대로) ---
async function searchDocs(openai, supabase, query, filterSource = null, topK = 5) {
  const [qEmbed] = await embed(openai, [query]);
  const { data, error } = await supabase.rpc("match_documents", {
    query_embedding: qEmbed, match_count: topK, filter_source: filterSource
  });
  if (error) throw error;
  return data;
}
function pickAgent(userText) {
  const t = userText.toLowerCase();
  const company = ["취업규칙","단체협약","임금협약","연차","휴가","특별휴가","수당","교대","승진","밴드"];
  const law = ["근로기준법","연차유급휴가","해고","서면통지","고용보험","산재","유연근무","출산휴가","육아휴직"];
  if (company.some(k => t.includes(k))) return "company";
  if (law.some(k => t.includes(k))) return "law";
  return "mix";
}
async function agentCompany(openai, supabase, q) {
  const hits = await searchDocs(openai, supabase, q, "회사취업규칙").catch(()=>[]);
  const more1 = hits.length<3 ? await searchDocs(openai, supabase, q, "단체협약").catch(()=>[]) : [];
  const more2 = hits.length+more1.length<3 ? await searchDocs(openai, supabase, q, "임금협약서").catch(()=>[]) : [];
  return { name: "회사 내규", contexts: [...hits, ...more1, ...more2] };
}
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
async function answerWithLLM(openai, userText, bundles) {
  const system = `당신은 HR/노무 챗봇입니다. 회사규정→법령 순으로 근거를 들어 간결히 답하세요. 핵심 bullet, 마지막에 "주의/근거" 2~3줄. 한국어.`;
  const ctx = bundles.flatMap(b => b.contexts)
    .map(c => `【${c.source}/${c.title}】 ${c.content.slice(0,500)}`).join("\n\n");
  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{role:"system",content:system},{role:"user",content:`[사용자 질문]\n${userText}\n\n[검색된 근거]\n${ctx}`}],
    temperature: 0.2
  });
  return res.choices[0]?.message?.content?.trim() || "답변 생성 실패";
}
app.post("/kakao", async (req, res) => {
  try {
    if (KAKAO_SKILL_SECRET) {
      const token = req.headers["x-skill-secret"];
      if (token !== KAKAO_SKILL_SECRET) return res.status(403).json({ error: "forbidden" });
    }
    const openai = getOpenAI();
    const supabase = getSupabase();

    const userText = req.body?.userRequest?.utterance || "";
    const userId = req.body?.userRequest?.user?.id || "anon";

    const mode = pickAgent(userText);
    const company = await agentCompany(openai, supabase, userText);
    const law = await agentLaw(openai, supabase, userText);
    const bundles = mode === "company" ? [company] : mode === "law" ? [law] : [company, law];

    const finalText = await answerWithLLM(openai, userText, bundles);

    // 메모리는 실패해도 서비스 유지
    try {
      const [qEmbed] = await embed(openai, [userText]);
      await supabase.from("qa_memory").insert({ user_id: userId, question: userText, answer: finalText, embedding: qEmbed });
    } catch (e) { console.warn("qa_memory save warn:", e.message); }

    return res.json({
      version: "2.0",
      template: {
        outputs: [{ simpleText: { text: finalText.slice(0, 2500) } }],
        quickReplies: [
          { label: "회사규정으로 다시", action: "message", messageText: "회사 규정 기준으로 다시 알려줘" },
          { label: "법 기준으로 다시", action: "message", messageText: "법 기준으로 다시 알려줘" }
        ]
      }
    });
  } catch (e) {
    console.error(e);
    return res.json({
      version: "2.0",
      template: { outputs: [{ simpleText: { text: "잠시 오류가 발생했어요. 조금 뒤 다시 시도해 주세요." } }] }
    });
  }
});

export default serverless(app);
