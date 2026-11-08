'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'campusos-test-'));
process.env.DB_PATH=path.join(root,'pilot.db');
process.env.CAMPUS_ADMIN_EMAIL='admin@example.org';
process.env.CAMPUS_ADMIN_PASSWORD='Strong-demo-password-93872';
process.env.OPENAI_API_KEY='';
const {server,db}=require('../server');
let origin='';
const cookie={};
async function request(who,endpoint,method='GET',data){const isBinary=Buffer.isBuffer(data);const res=await fetch(origin+'/api'+endpoint,{method,headers:{...(cookie[who]?{Cookie:cookie[who]}:{}),...(data?{'Content-Type':isBinary?'audio/webm':'application/json'}:{})},body:data?(isBinary?data:JSON.stringify(data)):undefined});if(res.headers.get('set-cookie'))cookie[who]=res.headers.get('set-cookie').split(';')[0];const text=await res.text();let body;try{body=JSON.parse(text)}catch{body=text}return {status:res.status,body}}
test.before(async()=>{await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${server.address().port}`});
test.after(async()=>{await new Promise(resolve=>server.close(resolve));db.close();fs.rmSync(root,{force:true,recursive:true})});
const pw='TestAccountPassword!!123';
test('Accounts, lecturer approvals, meeting rooms, recording isolation, analysis and knowledge controls',async()=>{
 let x=await request('admin','/login','POST',{institution_id:1,email:'admin@example.org',password:'Strong-demo-password-93872'});assert.equal(x.status,200);
 x=await request('lecturer','/register','POST',{institution_id:1,name:'Faculty Applicant',email:'faculty@example.org',password:pw,role:'lecturer'});assert.equal(x.status,201);
 assert.equal(x.body.user.role,'student');assert.equal(x.body.user.requested_role,'lecturer');
 x=await request('student','/register','POST',{institution_id:1,name:'Student A',email:'student@example.org',password:pw,role:'student'});assert.equal(x.status,201);
 x=await request('other','/register','POST',{institution_id:1,name:'Student B',email:'other@example.org',password:pw,role:'student'});assert.equal(x.status,201);
 x=await request('lecturer','/workspaces','POST',{title:'Design Lecture',kind:'lecture',guidance:'coach'});assert.equal(x.status,403);
 x=await request('admin','/admin/lecturer-applications');assert.equal(x.body.applications.length,1);
 x=await request('admin','/admin/lecturer-applications','POST',{user_id:x.body.applications[0].id,decision:'approve'});assert.equal(x.status,200);
 x=await request('lecturer','/workspaces','POST',{title:'Design Lecture',kind:'lecture',guidance:'socratic',instructions:'Ask students to think independently first.'});assert.equal(x.status,201);const roomId=x.body.id,joinCode=x.body.joinCode;
 x=await request('student',`/workspaces/${roomId}`);assert.equal(x.status,403);
 x=await request('student','/workspaces/join','POST',{code:joinCode});assert.equal(x.status,200);
 x=await request('student',`/workspaces/${roomId}/notes`,'POST',{category:'minutes',content:'Agreed to study chapter 5. Alex will share the draft by Friday.'});assert.equal(x.status,201);
 x=await request('other',`/workspaces/${roomId}`);assert.equal(x.status,403);
 x=await request('student',`/workspaces/${roomId}/analyze`,'POST',{});assert.equal(x.status,200);assert.match(x.body.report,/ACTION ITEMS/);
 x=await request('student',`/workspaces/${roomId}/assistant`,'POST',{prompt:'Help with chapter 5'});assert.equal(x.status,503);
 // WebM test payload is an opaque blob; storage access restricted regardless of whether browser MIME is valid.
 x=await request('student',`/workspaces/${roomId}/recordings`,'POST',Buffer.from('stubbed-webm-audio'));assert.equal(x.status,201);const recId=x.body.id;
 x=await request('lecturer',`/workspaces/${roomId}`);assert.equal(x.status,200);assert.equal(x.body.recordings.length,0);
 x=await request('lecturer',`/workspaces/recordings/${recId}/audio`);assert.equal(x.status,403);
 x=await request('student',`/workspaces/recordings/${recId}`,'PATCH',{transcript:'This is our approved meeting transcript.',shared:true});assert.equal(x.status,200);
 x=await request('lecturer',`/workspaces/${roomId}`);assert.equal(x.body.recordings.length,1);assert.match(x.body.recordings[0].transcript,/approved/);
 x=await request('student',`/workspaces/${roomId}/analyze`,'POST',{recording_id:recId});assert.equal(x.status,200);
 x=await request('lecturer',`/workspaces/${roomId}/analyze`,'POST',{recording_id:recId});assert.equal(x.status,403);
 x=await request('student','/knowledge');assert.equal(x.status,403);
 x=await request('admin','/knowledge','POST',{title:'Campus rulebook',content:'Exams must follow the course instruction rules.'});assert.equal(x.status,201);
 x=await request('admin','/knowledge');assert.equal(x.body.knowledge.length,1);
});

test('Hybrid AI provider settings are admin-only and persist across requests',async()=>{
 let x=await request('admin','/login','POST',{institution_id:1,email:'admin@example.org',password:'Strong-demo-password-93872'});assert.equal(x.status,200);
 x=await request('student','/login','POST',{institution_id:1,email:'student@example.org',password:pw});assert.equal(x.status,200);
 x=await request('student','/ai/settings');assert.equal(x.status,403);
 x=await request('student','/ai/settings','PATCH',{provider:'ollama'});assert.equal(x.status,403);
 x=await request('admin','/ai/settings');assert.equal(x.status,200);assert.equal(x.body.provider,'off');assert.equal(x.body.aiEnabled,false);
 x=await request('admin','/ai/settings','PATCH',{provider:'unsupported'});assert.equal(x.status,400);
 x=await request('admin','/ai/settings','PATCH',{provider:'ollama'});assert.equal(x.status,200);assert.equal(x.body.provider,'ollama');assert.equal(x.body.aiEnabled,true);
 x=await request('student','/workspaces');assert.equal(x.status,200);assert.equal(x.body.provider,'ollama');
 x=await request('admin','/ai/settings','PATCH',{provider:'openai'});assert.equal(x.status,200);assert.equal(x.body.aiEnabled,false);
 x=await request('admin','/ai/test','POST',{});assert.equal(x.status,503);
 x=await request('admin','/ai/settings','PATCH',{provider:'off'});assert.equal(x.status,200);
 x=await request('admin','/ai/settings');assert.equal(x.body.provider,'off');
});

test('Workspace assistant and meeting minutes really route through a configured local model',async()=>{
 const http=require('node:http');let lastRequest=null;
 const mock=http.createServer(async(req,res)=>{
  if(req.method!=='POST'||req.url!=='/api/chat'){res.writeHead(404);return res.end()}
  let raw='';for await(const x of req)raw+=x;
  lastRequest=JSON.parse(raw);
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({message:{role:'assistant',content:'A locally generated teaching reply.'}}));
 });
 await new Promise(resolve=>mock.listen(0,'127.0.0.1',resolve));
 const prior=process.env.CAMPUS_OLLAMA_URL;
 process.env.CAMPUS_OLLAMA_URL='http://127.0.0.1:'+mock.address().port;
 try{
  let x=await request('admin','/login','POST',{institution_id:1,email:'admin@example.org',password:'Strong-demo-password-93872'});assert.equal(x.status,200);
  x=await request('student','/login','POST',{institution_id:1,email:'student@example.org',password:pw});assert.equal(x.status,200);
  x=await request('admin','/ai/settings','PATCH',{provider:'ollama'});assert.equal(x.status,200);
  x=await request('student','/workspaces','POST',{title:'Hybrid test team',kind:'meeting',guidance:'coach'});assert.equal(x.status,201);const roomId=x.body.id;
  x=await request('student',`/workspaces/${roomId}/assistant`,'POST',{prompt:'Explain our team assignment'});assert.equal(x.status,200);
  assert.match(x.body.answer,/locally generated/);assert.equal(lastRequest.model,'llama3.2');
  assert.equal(lastRequest.messages.at(-1).content,'Explain our team assignment');
  assert.match(lastRequest.messages[0].content,/Campus OS/);
  x=await request('student',`/workspaces/${roomId}/notes`,'POST',{category:'minutes',content:'We agreed to share the project outline by Monday.'});assert.equal(x.status,201);
  x=await request('student',`/workspaces/${roomId}/analyze`,'POST',{});assert.equal(x.status,200);assert.equal(x.body.source,'AI draft');
  x=await request('admin','/ai/test','POST',{});assert.equal(x.status,200);assert.match(x.body.answer,/locally generated/);
 }finally{
  if(prior===undefined)delete process.env.CAMPUS_OLLAMA_URL;else process.env.CAMPUS_OLLAMA_URL=prior;
  await new Promise(resolve=>mock.close(resolve));
 }
});
