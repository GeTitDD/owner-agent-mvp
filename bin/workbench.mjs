#!/usr/bin/env node
import { createWorkbenchServer } from '../src/workbench-server.mjs';
import { resolveObserverDbPath } from '../src/observer/db-path.mjs';
const port=process.env.DOMAIN_WORKBENCH_PORT ? Number(process.env.DOMAIN_WORKBENCH_PORT) : 4317;
// 观察台读 Owner 审计库：独立性启动时也要能找到桌面端的 owner.sqlite（或环境变量指定的库）。
const ownerDbPath=resolveObserverDbPath();
const wb=await createWorkbenchServer({port,ownerDbPath});
const addr=await wb.listen();
console.log(`Domain Knowledge Workbench: http://127.0.0.1:${addr.port}`);
console.log(`Observer owner db: ${ownerDbPath}`);
console.log('Local-only. Press Ctrl+C to stop.');
const stop=async()=>{await wb.close();process.exit(0);};
process.once('SIGINT',stop);process.once('SIGTERM',stop);
