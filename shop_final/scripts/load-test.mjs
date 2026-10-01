const base = (process.env.BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const clients = Number(process.env.LOAD_CLIENTS || 25);
const rounds = Number(process.env.LOAD_ROUNDS || 8);
const targets = ['/', '/shop', '/shop?search=a', '/stories', '/privacy', '/terms'];

if (import.meta.url.endsWith('/load-test.mjs')) {
  console.log(`Load test target: ${base} | virtual clients: ${clients} | rounds/client: ${rounds}`);
  const samples=[];
  let errors=0;
  const start=performance.now();
  await Promise.all(Array.from({length:clients}, async(_,client)=>{
    for(let round=0; round<rounds; round++){
      const target=targets[(client+round)%targets.length];
      const t=performance.now();
      try{
        const res=await fetch(base+target,{redirect:'manual'});
        samples.push(performance.now()-t);
        if(res.status>=500) errors++;
        await res.arrayBuffer();
      }catch{ errors++; }
    }
  }));
  const elapsed=performance.now()-start;
  samples.sort((a,b)=>a-b);
  const at=p=>samples[Math.min(samples.length-1,Math.floor(samples.length*p))]||0;
  console.log(JSON.stringify({requests:samples.length,errors,totalMs:Math.round(elapsed),requestsPerSecond:Number((samples.length/(elapsed/1000)).toFixed(2)),p50Ms:Number(at(.50).toFixed(1)),p95Ms:Number(at(.95).toFixed(1)),p99Ms:Number(at(.99).toFixed(1))},null,2));
  if(errors>0) process.exitCode=1;
}
