// api/admin.js — 초경량 /admin (타임아웃 방지용)
export default function handler(req, res) {
  // 업로드 폼만 즉시 반환
  res.status(200).send(`
    <h3>PDF 업로드(관리자)</h3>
    <form action="/upload" method="post" enctype="multipart/form-data">
      <p><input type="password" name="pw" placeholder="ADMIN_PASSWORD" /></p>
      <p><input type="text" name="source" placeholder="문서출처(예: 회사취업규칙/근로기준법)" /></p>
      <p><input type="text" name="title" placeholder="문서제목(파일명)" /></p>
      <p><input type="file" name="file" /></p>
      <button>업로드</button>
    </form>
  `);
}
