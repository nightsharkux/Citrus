'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),os=require('node:os'),fs=require('node:fs');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'campusos-experience-test-'));
process.env.DB_PATH=path.join(tmp,'campusos.db');process.env.CAMPUS_ADMIN_EMAIL='testadmin@demo.invalid';process.env.CAMPUS_ADMIN_PASSWORD='TEST-admin-password-do-not-use';
const {server,db}=require('../server');
const bootstrap=async()=>new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const call=async(base,url,{method='GET',body,cookie}={})=>{const r=await fetch(base+url,{method,headers:{...(cookie?{cookie}:{}),...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});const json=await r.json();return {status:r.status,json,cookie:r.headers.get('set-cookie')?.split(';')[0]}};
test('Citrus Connect moderation and participation remain role scoped',async()=>{
 await bootstrap();const base=`http://127.0.0.1:${server.address().port}/api`;
 try{
  const admin=await call(base,'/login',{method:'POST',body:{institution_id:1,email:process.env.CAMPUS_ADMIN_EMAIL,password:process.env.CAMPUS_ADMIN_PASSWORD}});
  assert.equal(admin.status,200);const ac=admin.cookie;
  const signup=await call(base,'/register',{method:'POST',body:{institution_id:1,name:'Test Student',email:'student@demo.invalid',password:'TestStudentPassword123!',role:'student'}});
  assert.equal(signup.status,201);const student=await call(base,'/login',{method:'POST',body:{institution_id:1,email:'student@demo.invalid',password:'TestStudentPassword123!'}});assert.equal(student.status,200);const sc=student.cookie;
  assert.equal((await call(base,'/connect/moderation',{cookie:sc})).status,403);
  const post=await call(base,'/connect/posts',{cookie:sc,method:'POST',body:{title:'Test sublet request',body:'A short fictional room listing for testing.',category:'housing',official:true}});
  assert.equal(post.json.status,'pending');assert.equal((await call(base,'/connect/posts',{cookie:ac})).json.posts[0].verified,0);
  assert.equal((await call(base,'/connect/moderation',{cookie:ac})).json.pending.length,1);
  await call(base,'/connect/moderation',{cookie:ac,method:'POST',body:{id:post.json.id,action:'publish'}});
  const feed=await call(base,'/connect/posts',{cookie:sc});assert.equal(feed.json.posts[0].verified,1);
  const cmd=await call(base,'/connect/command',{cookie:sc,method:'POST',body:{text:'Essential notifications only'}});assert.equal(cmd.json.preferences.level,'essential');
  assert.equal((await call(base,'/participation/1/checkin',{cookie:sc,method:'POST',body:{}})).status,404);
  const sess=await call(base,'/participation',{cookie:ac,method:'POST',body:{course_id:1,title:'Cohort meeting',room:'MF2'}});assert.equal(sess.status,201);
  assert.equal((await call(base,`/participation/${sess.json.id}/checkin`,{cookie:sc,method:'POST',body:{}})).status,403);
  assert.equal((await call(base,'/courses/1/enroll',{cookie:sc,method:'POST',body:{}})).status,200);
  assert.equal((await call(base,`/participation/${sess.json.id}/checkin`,{cookie:sc,method:'POST',body:{}})).status,200);
  assert.equal((await call(base,`/participation/${sess.json.id}/checkin`,{cookie:sc,method:'POST',body:{user_id:1}})).status,403);
  const noConsent=await call(base,`/participation/${sess.json.id}/nfc/bind`,{cookie:ac,method:'POST',body:{user_id:2,card_uid:'A1B2C3D4'}});assert.equal(noConsent.status,400);
  const paired=await call(base,`/participation/${sess.json.id}/nfc/bind`,{cookie:ac,method:'POST',body:{user_id:2,card_uid:'A1B2C3D4',confirm_student_consent:true}});assert.equal(paired.status,200);
  const tap=await call(base,`/participation/${sess.json.id}/nfc/checkin`,{cookie:ac,method:'POST',body:{card_uid:'A1B2C3D4'}});assert.equal(tap.status,200);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM cx_nfc_bindings WHERE uid_digest=?').get('A1B2C3D4').count,0);
  const exportData=await call(base,'/admin/export',{cookie:ac});assert.equal(exportData.status,200);assert.equal(exportData.json.connectPosts.length,1);assert.equal(exportData.json.participationSessions.length,1);
 }finally{await new Promise(done=>server.close(done));db.close();fs.rmSync(tmp,{recursive:true,force:true})}
});
