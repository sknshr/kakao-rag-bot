// api/router.js — 순수 핸들러(Express 미사용). 카카오 웹훅 실전형.

const SECRET = process.env.KAKAO_SKILL_SECRET || null;

// 요청 본문을 JSON으로 읽기 (Vercel Node 함수는 JSON 자동 파싱 X)
async function readJson(req) {
  const buffers = [];
  for await (const chunk of req) buffers.push(chunk);
  const raw = Buffer.concat(buffers).toString("utf8");
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (e) { return {}; }
}

// 카카오 응답 헬퍼
function kakaoText(text, quickReplies = []) {
  return {
    version: "2.0",
    template: {
      outputs: [{ simpleText: { text } }],
      quickReplies
    }
  };
}

export default async function handler(req, res) {
  try {
    // URL/쿼리 파싱
    const host = req.headers.host || "localhost";
    const url = new URL(req.url, `http://${host}`);
    const pathname = url.pathname;
    const q = url.searchParams;

    // 0) 헬스/디버그
    if (pathname === "/kakao/ping") {
      return res.status(200).json(
        kakaoText("pong")
      );
    }
    if (pathname === "/kakao" && (q.has("fast") || q.get("fast") === "1")) {
      // fast=1 은 시크릿 검증도 건너뜀 (연결 확인용)
      return res.status(200).json(
        kakaoText("pong(fast-debug)")
      );
    }

    // 1) /kakao 이외 경로
    if (pathname !== "/kakao") {
      return res.status(404).json({ error: "not-found", path: pathname });
    }

    // 2) 시크릿 검증 (fast 디버그 제외)
    if (SECRET) {
      const token = req.headers["x-skill-secret"] || q.get("secret");
      if (token !== SECRET) {
        return res.status(403).json({ error: "forbidden" });
      }
    }

    // 3) 메서드 분기
    if (req.method === "GET") {
      // GET /kakao (간단 안내)
      return res.status(200).json(
        kakaoText("카카오 웹훅 OK (GET). 테스트는 POST로 보내주세요.")
      );
    }

    if (req.method === "POST") {
      // 4) JSON 본문 읽기
      const body = await readJson(req);

      // 카카오 스킬 테스트/실운영 공통 필드
      const utterance = body?.userRequest?.utterance || "";
      const userId = body?.userRequest?.user?.id || "anon";

      // 👉 여기서부터 실제 답변 생성 로직을 붙입니다.
      //    지금은 연결 확인용으로 '에코 + OK'만 반환합니다.
      const reply = utterance
        ? `연결 OK ✅\n- 사용자: ${userId}\n- 발화: ${utterance}`
        : `연결 OK ✅\n(본문에 utterance가 없습니다)`;

      const quick = [
        { label: "회사규정으로", action: "message", messageText: "회사 규정 기준으로 다시 알려줘" },
        { label: "법 기준으로", action: "message", messageText: "법 기준으로 다시 알려줘" }
      ];

      return res.status(200).json(kakaoText(reply, quick));
    }

    // 그 외 메서드
    return res.status(405).json({ error: "method-not-allowed" });
  } catch (e) {
    console.error("router error:", e);
    return res.status(500).json({ error: "router-failed", message: String(e) });
  }
}
