// api/index.js
// ✅ Vercel 서버리스 환경에서 Express를 쓰기 위해 serverless-http로 핸들러를 export합니다.
import express from "express";
import multer from "multer";
import pdfParse from "pdf-parse";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import serverless from "serverless-http";

const app = express();

// 카카오 요청은 JSON 바디(크지 않음)
app.use(express.json({ limit: "5mb" }));

// PDF 업로드(최대 50MB)
const upload = multer({ limits: { fileSize: 50 * 1024 * 1024 } });

// --- 환경변수 ---
const {
  OPENAI_API_KEY,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  ADMIN_PASSWORD,
  KAKAO_SKILL_SECRET
} = process.env;

// --- 클라이언트 준비 ---
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// --- 유틸: 텍스트 청크 ---
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

// --- 유틸: 임베딩 ---
async function embed(texts) {
  const res = await openai.embeddings.create({
    model: "text-embedding-3-large",
    input: texts
  });
  return res.data.map(d => d.embedding);
}

// --- 간단 홈(헬스체크) ---
app.get("/", (req, res) => {
  res.status(200).send("OK - kakao-rag-bot");
});

// --- 초간단 업로드 폼(Admin 전용) ---
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

// --- PDF 업로드 + 인덱싱 ---
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    const { pw, source = "기타", title = "문서" } = req.body;
    if (pw !== ADMIN_PASSWORD) return res.status(403).send("비밀번호 오류");

    if (!req.file?.buffer) return res.status(400).send("파일이 없습니다.");

    const data = await pdfParse(req.file.buffer);
    const chunks = chunkText(data.text);
    const embeddings = await embed(chunks);

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

// --- 벡터 검색 ---
async function searchDocs(query, filterSource = null, topK = 5) {
  const [qEmbed] = await embed([query]);
  const { data, error } = await supabase
    .rpc("match_documents", {
      query_embedding: qEmbed,
      match_count: topK,
      filter_source: filterSource
    });
  if (error) throw error;
  return data;
}

// --- 라우팅(어느 에이전트?) ---
function pickAgent(userText) {
  const t = userText.toLowerCase();
  const companyKeywords = ["취업규칙","단체협약","임금협약","연차","휴가","특별휴가","수당","교대","승진","밴드"];
  const lawKeywords = ["근로기준법","연차유급휴가","해고","서면통지","고용보험","산재","유연근무","출산휴가","육아휴직"];
  if (companyKeywords.some(k => t.includes(k))) return "company";
  if (lawKeywords.some(k => t.includes(k))) return "law";
  return "mix";
}

// --- 에이전트들 ---
async function agentCompany(query) {
  const hits = await searchDocs(query, "회사취업규칙").catch(()=>[]);
  const more1 = hits.length<3 ? await searchDocs(query, "단체협약").catch(()=>[]) : [];
  const more2 = hits.length+more1.length<3 ? await searchDocs(query, "임금협약서").catch(()=>[]) : [];
  const contexts = [...hits, ...more1, ...more2];
  return { name: "회사 내규", contexts };
}

async function agentLaw(query) {
  const pool = ["근로기준법","고용보험법","산재보험법","유연근무매뉴얼","노무관리가이드북","질의회시집","양성평등기본법"];
  let contexts = [];
  for (const src of pool) {
    const got = await searchDocs(query, src).catch(()=>[]);
    contexts = contexts.concat(got);
    if (contexts.length>6) break;
  }
  return { name: "법령 기준", contexts: contexts.slice(0,6) };
}

function agentFactCheck(companyAns, lawAns) {
  return { name: "팩트체크", note: "회사 규정과 법령을 함께 제시. 충돌 시 법 우선." };
}

// --- LLM 답변 생성 ---
async function answerWithLLM(userText, bundles) {
  const system = `
당신은 HR/노무 챗봇입니다. 회사규정→법령 순으로 근거를 들어 간결히 답하세요.
핵심 bullet로, 마지막에 "주의/근거"를 2~3줄로 요약하세요. 한국어.
`;
  const contextTxt =
    bundles.flatMap(b => b.contexts)
           .map(c => `【${c.source}/${c.title}】 ${c.content.slice(0,500)}`)
           .join("\n\n");

  const prompt = `
[사용자 질문]
${userText}

[검색된 근거(잘 읽고 핵심만 답변에 반영)]
${contextTxt}
`;

  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role:"system", content: system }, { role:"user", content: prompt }],
    temperature: 0.2
  });

  return res.choices[0]?.message?.content?.trim() || "답변 생성 실패";
}

// --- 지속학습 저장 ---
async function saveQAMemory(userId, q, a) {
  const [qEmbed] = await embed([q]);
  await supabase.from("qa_memory").insert({
    user_id: userId || "anon",
    question: q,
    answer: a,
    embedding: qEmbed
  });
}

// --- 카카오 스킬 엔드포인트 ---
app.post("/kakao", async (req, res) => {
  try {
    if (KAKAO_SKILL_SECRET) {
      const token = req.headers["x-skill-secret"];
      if (token !== KAKAO_SKILL_SECRET) return res.status(403).json({ error: "forbidden" });
    }

    const userText = req.body?.userRequest?.utterance || "";
    const userId = req.body?.userRequest?.user?.id || "anon";

    const mode = pickAgent(userText);
    const company = await agentCompany(userText);
    const law = await agentLaw(userText);
    let bundles = [];
    if (mode === "company") bundles = [company];
    else if (mode === "law") bundles = [law];
    else bundles = [company, law];

    agentFactCheck(company, law); // 현재는 규칙만 반영(추후 강화 가능)

    const finalText = await answerWithLLM(userText, bundles);
    saveQAMemory(userId, userText, finalText).catch(console.warn);

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

// ✅ Vercel 서버리스는 app.listen을 사용하지 않습니다.
//   대신 serverless(app)를 default로 export해야 합니다.
export default serverless(app);
