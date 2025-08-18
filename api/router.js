// api/router.js — Express 없이 순수 Vercel 핸들러(진단용)

export default async function handler(req, res) {
  try {
    // 요청 경로/쿼리 파싱
    const host = req.headers.host || "localhost";
    const url = new URL(req.url, `http://${host}`);
    const pathname = url.pathname;
    const q = url.searchParams;

    // 1) /kakao/ping : 즉시 JSON 응답
    if (pathname === "/kakao/ping") {
      return res.status(200).json({
        version: "2.0",
        template: { outputs: [ { simpleText: { text: "pong" } } ] }
      });
    }

    // 2) /kakao?fast : 즉시 JSON 응답 (시크릿 무시)
    if (pathname === "/kakao" && (q.has("fast") || q.get("fast") === "1")) {
      return res.status(200).json({
        version: "2.0",
        template: { outputs: [ { simpleText: { text: "pong(fast-debug)" } } ] }
      });
    }

    // 3) /kakao (POST) : 카카오 본요청 흉내 (바로 응답)
    if (pathname === "/kakao" && req.method === "POST") {
      return res.status(200).json({
        version: "2.0",
        template: { outputs: [ { simpleText: { text: "OK (router plain handler)" } } ] }
      });
    }

    // 그 외
    return res.status(404).json({ error: "not-found", path: pathname });
  } catch (e) {
    console.error("router error:", e);
    return res.status(500).json({ error: "router-failed", message: String(e) });
  }
}
