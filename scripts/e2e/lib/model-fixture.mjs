// 本机模拟模型服务：真实 SDK/HTTP/流式协议，只有模型输出是固定夹具；不记录鉴权头。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

export async function startModelFixture() {
  let mode = 'ok';
  const requests = [];
  const server = http.createServer(async (request, response) => {
    let body = '';
    for await (const part of request) body += part;
    requests.push({ path: request.url, body: JSON.parse(body || '{}') });
    if (mode === 'auth') {
      response.writeHead(401, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Unauthorized fixture credential', type: 'authentication_error', code: 'invalid_api_key' } }));
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const event = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({
      id: 'fixture-response', object: 'chat.completion.chunk', created: 1795700000, model: 'check',
      choices: [{ index: 0, delta, finish_reason }]
    })}\n\n`);
    event({ role: 'assistant', content: '模型连接正常。' });
    const finish = () => { if (response.destroyed) return; event({ content: '这是一条本机协议验收回复。' }); event({}, 'stop'); response.end('data: [DONE]\n\n'); };
    if (mode === 'slow') {
      const timer = setTimeout(finish, 5000);
      response.on('close', () => clearTimeout(timer));
    } else finish();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, requests,
    setMode: (value) => { mode = value; },
    close: async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); } };
}

export function seedModelFixture(agentDir, baseUrl) {
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({ providers: {
    'fixture-local': { api: 'openai-completions', baseUrl, apiKey: 'FIXTURE-NOT-A-REAL-CREDENTIAL', models: [{
      id: 'check', name: '本机连接验收模型', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1024
    }] }
  } }));
}
