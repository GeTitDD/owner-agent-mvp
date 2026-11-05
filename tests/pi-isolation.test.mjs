// REAL SDK integration test for project-level resource isolation (no model calls, no key).
// The project contains a project-local extension whose import writes a marker file.
// 1. CONTROL: a default loader with explicit trust DOES load it → proves the test can detect loading.
// 2. FACTORY: DefaultPiSessionFactory (noExtensions + empty agentDir) must NOT load it.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp,rm,writeFile } from 'node:fs/promises';
import { existsSync,mkdirSync } from 'node:fs';
import { DefaultPiSessionFactory } from '../src/pi-session-factory.mjs';

const mkProjectWithExtension=async(dir)=>{
  const project=path.join(dir,'proj');
  const marker=path.join(dir,'marker-written.txt');
  mkdirSync(path.join(project,'.pi','extensions'),{recursive:true});
  const ext=[
    `import fs from 'node:fs';`,
    `try{fs.writeFileSync(${JSON.stringify(marker)},'loaded');}catch{/* ignore */}`,
    `export default function piExtension(){/* factory would run at session start */}`
  ].join('\n');
  await writeFile(path.join(project,'.pi','extensions','marker.js'),ext,'utf8');
  await writeFile(path.join(project,'AGENTS.md'),'# project context that must NOT be injected\n','utf8');
  return {project,marker};
};

test('[pi-iso control] a default loader with explicit trust loads project extensions (detection works)',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'pi-iso-control-'));
  try{
    const {project,marker}=await mkProjectWithExtension(dir);
    const sdk=await import('@earendil-works/pi-coding-agent');
    const loader=new sdk.DefaultResourceLoader({cwd:project,agentDir:path.join(dir,'agentdir')});
    await loader.reload({resolveProjectTrust:async()=>true});
    assert.ok(existsSync(marker),'control: the extension WAS imported under default discovery+trust');
    const extensions=loader.getExtensions();
    const count=(extensions.extensions??extensions.results??[]).length;
    assert.ok(count>=1,'control: loader reports at least one extension');
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('[pi-iso factory] DefaultPiSessionFactory loads NO project resources and reports zero tools',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'pi-iso-factory-'));
  try{
    const {project,marker}=await mkProjectWithExtension(dir);
    const session=await DefaultPiSessionFactory.create({cwd:project});
    try{
      assert.equal(session.activeTools().length,0,'active tool set is empty');
      assert.ok(!existsSync(marker),'the project extension was never imported');
    }finally{session.dispose();}
  }finally{await rm(dir,{recursive:true,force:true});}
});
