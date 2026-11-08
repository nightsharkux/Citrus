'use strict';
// Migration helper: node scripts/import-storage.js "C:\\path\\to\\old-CampusOS"
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),from=process.argv[2];
if(!from){console.error('Usage: node scripts/import-storage.js "PATH_TO_PREVIOUS_CAMPUSOS_FOLDER"');process.exit(1)}
const src=path.resolve(from,'storage'),dst=path.join(root,'storage');
if(!fs.existsSync(path.join(src,'campusos.db'))){console.error('Source database not found: '+path.join(src,'campusos.db'));process.exit(1)}
if(fs.existsSync(path.join(dst,'campusos.db'))){console.error('Refusing to overwrite an existing CampusOS database. Back it up and remove only if you explicitly intend to replace it.');process.exit(1)}
fs.mkdirSync(dst,{recursive:true});fs.cpSync(src,dst,{recursive:true,force:false,errorOnExist:false});console.log('Storage copied from '+src+'. Start Campus OS to apply additive schema changes.');
