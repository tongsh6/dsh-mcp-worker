// 极简 OTLP/HTTP traces 收集器：把收到的 JSON 追加到第 2 个参数指定的文件，便于冒烟验证。
// 用法：node test/fixtures/otel-collector.mjs <port> <captureFile>
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 4318);
const captureFile = process.argv[3] ?? 'otel-capture.jsonl';

const server = createServer((req, res) => {
  let raw = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    raw += chunk;
  });
  req.on('end', () => {
    try {
      appendFileSync(captureFile, `${JSON.stringify({ url: req.url, body: JSON.parse(raw || '{}') })}\n`);
    } catch {
      // 忽略坏请求
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`[otel-collector] listening on 127.0.0.1:${port} -> ${captureFile}\n`);
});
