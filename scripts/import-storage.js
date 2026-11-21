'use strict';
// Migration helper: node scripts/import-storage.js "C:\\path\\to\\previous-install"
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),from=process.argv[2];
if(!from){console.error('Usage: node scripts/import-storage.js "PATH_TO_PREVIOUS_INSTALL"');process.exit(1)}
const src=path.resolve(from,'storage'),dst=path.join(root,'storage');
// Older installs called the database campusos.db; Citrus renames it to citrus.db the first time it starts.
const has=(dir)=>['citrus.db','campusos.db'].some((n)=>fs.existsSync(path.join(dir,n)));
if(!has(src)){console.error('Source database not found in: '+src);process.exit(1)}
if(has(dst)){console.error('Refusing to overwrite an existing Citrus database. Back it up and remove only if you explicitly intend to replace it.');process.exit(1)}
fs.mkdirSync(dst,{recursive:true});fs.cpSync(src,dst,{recursive:true,force:false,errorOnExist:false});console.log('Storage copied from '+src+'. Start Citrus to apply additive schema changes.');
