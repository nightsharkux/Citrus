'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'campusos-one-test-'));
process.env.DB_PATH=path.join(tmp,'test.db');process.env.CAMPUS_ADMIN_EMAIL='one-admin@example.invalid';process.env.CAMPUS_ADMIN_PASSWORD='OnlyTestPasswordLongAndPrivate123!';
process.env.CAMPUS_REQUIRE_AGREEMENT='off'; // these tests predate the agreement; tests/agreement.test.js covers it
const {server,db}=require('../server');
const request=async (base,p,opts={})=>{const res=await fetch(base+p,{method:opts.method||'GET',headers:{...(opts.cookie?{cookie:opts.cookie}:{}),...(opts.body?{'content-type':'application/json'}:{})},body:opts.body?JSON.stringify(opts.body):undefined});return {status:res.status,data:await res.json(),cookie:res.headers.get('set-cookie')?.split(';')[0]}};
test('Career explorer saves user-specific answers, rejects invalid input, and never exposes other users',async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+server.address().port+'/api';
 try {
  const guest=await request(base,'/career');assert.equal(guest.status,401);
  const a=await request(base,'/register',{method:'POST',body:{institution_id:1,name:'Career Student One',email:'one@example.invalid',password:'CareerExamplePass1234!'}});
  const b=await request(base,'/register',{method:'POST',body:{institution_id:1,name:'Career Student Two',email:'two@example.invalid',password:'CareerExamplePass1234!'}});
  assert.equal(a.status,201);assert.equal(b.status,201);
  const cb=a.cookie,db2=b.cookie;
  let career=await request(base,'/career',{cookie:cb});assert.equal(career.status,200);assert.equal(career.data.questions.length,18);assert.equal(career.data.answers,null);
  assert.ok(!('traits' in career.data.questions[0]),'Scoring traits must not be part of client questions');
  const invalid=await request(base,'/career',{cookie:cb,method:'POST',body:{answers:[1,2]}});assert.equal(invalid.status,400);
  const answers=Array.from({length:18},(_,i)=>i%4);
  let saved=await request(base,'/career',{cookie:cb,method:'POST',body:{answers}});assert.equal(saved.status,200);assert.equal(saved.data.result.answered,18);assert.equal(saved.data.result.recommendations.length,4);
  career=await request(base,'/career',{cookie:cb});assert.deepEqual(career.data.answers,answers);
  const other=await request(base,'/career',{cookie:db2});assert.equal(other.data.answers,null);assert.equal(other.data.result,null);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM career_interests').get().n,1);
 } finally {await new Promise(resolve=>server.close(resolve));db.close();fs.rmSync(tmp,{recursive:true,force:true})}
});
