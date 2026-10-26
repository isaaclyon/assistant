import {execFileSync} from 'node:child_process';
import {it,expect} from 'vitest';
it('media-stack collector validates input, bounds output and reaches only configured loopback services',()=>{
 expect(()=>execFileSync('python3',['-B','tests/fixtures/media-stack-collector-test.py'],{encoding:'utf8',timeout:60000,stdio:'pipe'})).not.toThrow();
});
