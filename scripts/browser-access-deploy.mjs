import {readFile,lstat,realpath} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
export async function browserAccessSecrets(file){
  file=path.resolve(file);const stat=await lstat(file);
  assert.equal(await realpath(file),file,'BROWSER_SECRET_REGULAR_FILE_REQUIRED');
  assert(stat.isFile()&&stat.nlink===1&&(stat.mode&0o077)===0&&stat.size<8192,'BROWSER_SECRET_PRIVATE_FILE_REQUIRED');
  const value=JSON.parse(await readFile(file,'utf8'));
  assert.deepEqual(Object.keys(value).sort(),['BROWSER_BASIC_PASSWORD','BROWSER_BASIC_USER'],'BROWSER_SECRET_KEYS_REQUIRED');
  assert(typeof value.BROWSER_BASIC_USER==='string'&&value.BROWSER_BASIC_USER.length>0&&value.BROWSER_BASIC_USER.length<=128&&!/[:\r\n\x00]/.test(value.BROWSER_BASIC_USER),'BROWSER_SECRET_USER_INVALID');
  assert(typeof value.BROWSER_BASIC_PASSWORD==='string'&&value.BROWSER_BASIC_PASSWORD.length>=8&&value.BROWSER_BASIC_PASSWORD.length<=512&&!/[\r\n\x00]/.test(value.BROWSER_BASIC_PASSWORD),'BROWSER_SECRET_PASSWORD_INVALID');
  return value;
}
