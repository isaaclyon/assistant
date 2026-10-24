import {execFileSync} from 'node:child_process';
import {it,expect} from 'vitest';
it('read-only Linux monitoring policy, collection, failures and persistence',()=>{
 expect(()=>execFileSync('python3',['-B','tests/fixtures/linux-host-monitor-test.py'],{encoding:'utf8',timeout:30000,stdio:'pipe'})).not.toThrow();
});
