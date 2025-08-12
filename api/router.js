// step-1: 최소 핸들러(라우팅/배포 확인용)
export default function handler(req, res) {
  res.status(200).send("OK - step-1 (new function)");
}
