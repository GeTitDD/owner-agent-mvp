#!/usr/bin/env node
import { createWorkbenchServer } from '../src/workbench-server.mjs';
const port=process.env.DOMAIN_WORKBENCH_PORT ? Number(process.env.DOMAIN_WORKBENCH_PORT) : 4317;
const wb=await createWorkbenchServer({port});
const addr=await wb.listen();
console.log(`Domain Knowledge Workbench: http://127.0.0.1:${addr.port}`);
console.log('Local-only. Press Ctrl+C to stop.');
const stop=async()=>{await wb.close();process.exit(0);};
process.once('SIGINT',stop);process.once('SIGTERM',stop);
