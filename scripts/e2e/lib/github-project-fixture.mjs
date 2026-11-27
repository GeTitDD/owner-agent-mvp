// 仅供测试：把 GitHub 传输替换为真实本机 bare 仓库，其他 Git 检查和应用流程保持原样。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runProjectGit, GitHubProjectError } from '../../../src/github-project.mjs';

export const FIXTURE_GITHUB_SOURCE='https://github.com/fixture-owner/owner-demo.git';
export function createGitHubProjectFixture(root,{existing=false}={}) {
  const seed=path.join(root,'seed'),remote=path.join(root,'remote.git');fs.mkdirSync(seed,{recursive:true});
  const git=args=>execFileSync('git',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  if(!existing){
  git(['init','--quiet','--template=',seed]);
  fs.writeFileSync(path.join(seed,'README.md'),'# GitHub 添加项目 · 本机真实 Git 夹具\n');
  fs.writeFileSync(path.join(seed,'package.json'),JSON.stringify({scripts:{postinstall:'node -e "require(\'fs\').writeFileSync(\'must-not-run\',\'bad\')"'}}));
  git(['-C',seed,'add','.']);git(['-C',seed,'-c','core.hooksPath='+path.join(root,'no-hooks'),'-c','commit.gpgsign=false','-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--quiet','-m','fixture']);
  git(['-C',seed,'remote','add','origin',FIXTURE_GITHUB_SOURCE]);git(['clone','--quiet','--bare',seed,remote]);
  }
  let mode='ok';const calls=[];
  const run=async input=>{
    calls.push(input.args);
    if(!input.args.includes('clone')){
      if(input.args[0]!=='-C'||!['config','rev-parse'].includes(input.args[2]))throw Error('夹具拒绝未声明的 Git 操作');
      return runProjectGit(input);
    }
    if(mode==='failed')throw new GitHubProjectError('无法访问这个仓库。请核对地址、权限和本机 Git/GitHub 登录后重试。','git-failed');
    if(mode==='slow')await new Promise((resolve,reject)=>{
      if(input.signal?.aborted){reject(new GitHubProjectError('已取消下载，没有添加项目。','canceled'));return;}
      const canceled=()=>{clearTimeout(timer);reject(new GitHubProjectError('已取消下载，没有添加项目。','canceled'));};
      const timer=setTimeout(()=>{input.signal?.removeEventListener('abort',canceled);resolve();},6000);
      input.signal?.addEventListener('abort',canceled,{once:true});
      input.onProgress?.({phase:'正在下载对象',percent:35});
    });
    const args=[...input.args];const source=args.indexOf('--')+1;const url=args[source];args[source]=remote;
    const result=await runProjectGit({...input,args});
    // 模拟同一个 GitHub 仓库被取回后的真实 origin；生产来源核对不被跳过。
    git(['-C',args.at(-1),'remote','set-url','origin',mode==='wrong-remote'?'https://github.com/another/wrong.git':url]);
    return result;
  };
  return {seed,remote,git,run,calls,setMode:value=>{mode=value;}};
}
