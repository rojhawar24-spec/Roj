import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=path.resolve(new URL('..',import.meta.url).pathname);
const files=[];
function walk(dir){ for(const name of fs.readdirSync(dir)){ const p=path.join(dir,name),st=fs.statSync(p); if(st.isDirectory()) walk(p); else if(name.endsWith('.ejs')) files.push(p); } }
walk(path.join(root,'views'));
for(const file of files){
  const source=fs.readFileSync(file,'utf8');
  const forms=[...source.matchAll(/<form\b[\s\S]*?<\/form>/gi)].map(m=>m[0]);
  for(const form of forms){
    const method=form.match(/\bmethod=["']post["']/i);
    if(method) assert.ok(/name=["']_csrf["']/i.test(form) || /x-csrf-token/i.test(form),`POST form missing CSRF field in ${path.relative(root,file)}`);
  }
  for(const m of source.matchAll(/<script\b[^>]*src=["']([^"']+)["']/gi)) assert.ok(m[1].startsWith('/') || m[1].startsWith('https://'),`Unexpected script source in ${path.relative(root,file)}`);
  for(const m of source.matchAll(/target=["']_blank["'][^>]*>/gi)) assert.ok(/rel=["'][^"']*noopener/i.test(m[0]),`_blank link missing noopener in ${path.relative(root,file)}`);
}
console.log(`Template audit passed: ${files.length} EJS templates inspected.`);
