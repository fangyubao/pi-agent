'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {snapshot,compare,persist,readFileReview}=require('./file-changes.cjs');
test('per-turn snapshots detect new, changed and deleted files, excluding dependencies',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pi-file-review-'));
  try{
    await fs.writeFile(path.join(dir,'modified.txt'),'before\n');
    await fs.writeFile(path.join(dir,'deleted.txt'),'gone');
    const before=await snapshot(dir);
    await fs.writeFile(path.join(dir,'modified.txt'),'after\n');
    await fs.unlink(path.join(dir,'deleted.txt'));
    await fs.writeFile(path.join(dir,'new.txt'),'new');
    await fs.mkdir(path.join(dir,'node_modules'));
    await fs.writeFile(path.join(dir,'node_modules','ignore.txt'),'dependency');
    const result=compare(before,await snapshot(dir));
    assert.equal(result.files.length,3);
    const modified=result.files.find(x=>x.path==='modified.txt');
    assert.equal(modified.before,'before\n');assert.equal(modified.after,'after\n');
    assert.equal(result.files.find(x=>x.path==='new.txt').operation,'新增');
    assert.equal(result.files.find(x=>x.path==='deleted.txt').operation,'删除');
    assert.equal(compare(await snapshot(dir),await snapshot(dir)).files.length,0);
    const metadata=await persist(path.join(dir,'reviews'),result);
    assert.equal(metadata.files[0].before,undefined);
    const reloaded=await readFileReview(path.join(dir,'reviews'),metadata.files[0].reviewId,0);
    assert.equal(reloaded.path,metadata.files[0].path);
    await assert.rejects(readFileReview(path.join(dir,'reviews'),'../../data',0));
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('line diff retains unchanged lines between multiple edits',()=>{
  const diff=require('./text-diff.js').compare('a\nold\nkept\nbefore\nz','a\nnew\nkept\nafter\nz');
  assert.equal(diff.rows.find(x=>x.before==='kept').changed,false);
  assert.equal(diff.rows.filter(x=>x.changed).length,2);
});
