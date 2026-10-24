import importlib.util,pathlib,unittest,copy,tempfile,os,json
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('health',pathlib.Path(__file__).resolve().parents[2]/'scripts/linux-host-monitor.py')
h=importlib.util.module_from_spec(spec);spec.loader.exec_module(h)
G=1024**3
CONFIG={'version':1,'sourceId':'test','intervalSeconds':300,'mounts':{'system':{'warnPercent':80,'criticalPercent':90},'media':{'warnPercent':85,'criticalPercent':95,'warnFreeBytes':300*G,'criticalFreeBytes':100*G}},'containers':{'app':{'criticalDown':True},'vpn':{'criticalDown':True},'other':{'criticalDown':False}},'ram':{'warnBytes':G,'warnSeconds':900,'criticalBytes':500*1024**2,'criticalSeconds':600},'cpu':{'warnPercent':85,'criticalPercent':95,'forSeconds':1800,'contentionPercent':10},'backup':{'warnSeconds':36*3600,'criticalSeconds':60*3600}}
def sample(t=100000):
 return {'version':1,'sourceId':'test','at':t,'bootId':'test-boot','cpuTotal':t*100,'cpuIdle':t*90,'cpuPressure':0,'availableBytes':4*G,'mounts':{k:{'mounted':True,'readOnly':False,'usedPercent':20,'freeBytes':1000*G} for k in CONFIG['mounts']},'containers':{k:{'running':True,'health':'healthy'} for k in CONFIG['containers']},'backupSuccessAt':t-100}
class Policy(unittest.TestCase):
 def step(self,s,prev=None,**kw):return h.evaluate(s,prev,CONFIG,s['at'] if s else kw.pop('now'),**kw)
 def test_baseline_healthy(self):self.assertEqual(self.step(sample())['events'],[])
 def test_disk_boundaries_and_recovery(self):
  s=sample();s['mounts']['system']['usedPercent']=80;p=self.step(s);self.assertEqual(p['incidents']['disk-system']['severity'],'warning')
  s['at']+=300;s['mounts']['system']['usedPercent']=90;p=self.step(s,p);self.assertEqual(p['events'][-1]['changes'][0]['to'],'critical')
  s['at']+=300;s['mounts']['system']['usedPercent']=91;p2=self.step(s,p);self.assertEqual(p2['sequence'],p['sequence'])
  s['at']+=300;s['mounts']['system']['usedPercent']=20;p=self.step(s,p2);self.assertEqual(p['events'][-1]['changes'][0]['to'],'healthy')
 def test_media_free_or_percent(self):
  for free,pct,level in [(299*G,20,'warning'),(99*G,20,'critical'),(1000*G,85,'warning'),(1000*G,95,'critical')]:
   s=sample();s['mounts']['media'].update(freeBytes=free,usedPercent=pct);self.assertEqual(self.step(s)['incidents']['disk-media']['severity'],level)
 def test_missing_or_readonly_mount(self):
  for field in ['mounted','readOnly']:
   s=sample();s['mounts']['media'][field]=field=='readOnly';self.assertEqual(self.step(s)['incidents']['mount-media']['severity'],'critical')
 def test_ram_sustained(self):
  p=None
  for n in range(4):
   s=sample(100000+300*n);s['availableBytes']=800*1024**2;p=self.step(s,p)
   self.assertEqual('ram' in p['incidents'],n>=3)
 def test_ram_critical_after_ten_minutes(self):
  p=None
  for n in range(3):
   s=sample(100000+300*n);s['availableBytes']=400*1024**2;p=self.step(s,p)
  self.assertEqual(p['incidents']['ram']['severity'],'critical')
 def test_cpu_needs_baseline_duration_and_contention(self):
  for pressure,expected in [(0,'warning'),(12,'critical')]:
   p=None
   for n in range(7):
    s=sample(100000+300*n);s.update(cpuIdle=s['cpuTotal']*.02,cpuPressure=pressure);p=self.step(s,p)
   self.assertEqual(p['incidents']['cpu']['severity'],expected)
 def test_boot_change_does_not_compute_negative_cpu(self):
  p=self.step(sample());s=sample(100300);s.update(bootId='new',cpuTotal=10,cpuIdle=1);p=self.step(s,p);self.assertIsNone(p['cpuPercent'])
 def test_container_two_checks_and_immediate_critical(self):
  s=sample();s['containers']['other']['running']=False;p=self.step(s);self.assertNotIn('container-other',p['incidents'])
  s['at']+=300;p=self.step(s,p);self.assertEqual(p['incidents']['container-other']['severity'],'warning')
  s['containers']['app']['running']=False;s['at']+=300;p=self.step(s,p);self.assertEqual(p['incidents']['container-app']['severity'],'critical')
 def test_backup_age_and_unknown(self):
  for age,level in [(36*3600,'warning'),(60*3600,'critical')]:
   s=sample(1000000);s['backupSuccessAt']=s['at']-age;self.assertEqual(self.step(s)['incidents']['backup']['severity'],level)
  s=sample();s['backupSuccessAt']=None;self.assertEqual(self.step(s)['incidents']['backup']['severity'],'warning')
 def test_failure_preserves_incident_and_suppresses_repeat(self):
  s=sample();s['mounts']['system']['usedPercent']=95;p=self.step(s)
  p=self.step(None,p,now=100300);self.assertIn('disk-system',p['incidents']);self.assertIn('monitor',p['incidents'])
  q=self.step(None,p,now=100600);self.assertEqual(q['sequence'],p['sequence'])
  q=self.step(sample(100900),q);self.assertEqual(q['incidents'],{});self.assertTrue(all(e['to']=='healthy' for e in q['events'][-1]['changes']))
 def test_missing_samples_do_not_fabricate_sustained_pressure(self):
  s=sample();s['availableBytes']=800*1024**2;p=self.step(s)
  s['at']+=1200;p=self.step(s,p);self.assertNotIn('ram',p['incidents'])
 def test_failures_do_not_clear_existing_ram_alert(self):
  p=None
  for n in range(3):
   s=sample(100000+300*n);s['availableBytes']=400*1024**2;p=self.step(s,p)
  p=self.step(None,p,now=100900);s['at']=101200;p=self.step(s,p);self.assertEqual(p['incidents']['ram']['severity'],'critical')
 def test_maintenance_suppresses_onset_and_recovery_inside_window(self):
  p=self.step(sample());s=sample(100300);s['containers']['app']['running']=False;p=self.step(s,p,maintenance_until=101000);self.assertEqual(p['sequence'],0)
  p=self.step(sample(100600),p,maintenance_until=101000);p=self.step(sample(101200),p);self.assertEqual(p['sequence'],0)
 def test_maintenance_end_reports_remaining_problem(self):
  s=sample();s['containers']['app']['running']=False;p=self.step(s,maintenance_until=101000);s['at']=101200;p=self.step(s,p);self.assertEqual(p['sequence'],1)
 def test_event_history_bounded(self):
  p=None
  for n in range(100):
   s=sample(100000+n*300);s['mounts']['system']['usedPercent']=95 if n%2 else 20;p=self.step(s,p)
  self.assertLessEqual(len(p['events']),12);self.assertLess(len(json.dumps(h.report(p,CONFIG))),32768)
 def test_invalid_sample_never_becomes_healthy(self):
  for change in [{'sourceId':'wrong'},{'availableBytes':-1},{'cpuTotal':float('nan')},{'at':1},{'containers':{}},{'mounts':{}},{'cpuIdle':float('inf')}]:
   s=sample();s.update(change)
   with self.assertRaises(ValueError):h.validate_sample(s,CONFIG,100000)
 def test_no_follow_and_private_atomic_state(self):
  with tempfile.TemporaryDirectory() as d:
   p=pathlib.Path(d)/'state.json';h.atomic_json(str(p),{'a':1},0o600);self.assertEqual(h.read_json(str(p)),{'a':1});self.assertEqual(p.stat().st_mode&0o777,0o600)
   link=pathlib.Path(d)/'link';link.symlink_to(p)
   with self.assertRaises(OSError):h.read_json(str(link))
 def test_bounded_command_output_and_timeout(self):
  for argv,timeout in [(['/usr/bin/python3','-c','print("x"*100000)'],2),(['/usr/bin/python3','-c','import time;time.sleep(3)'],.05)]:
   with self.assertRaises(h.CollectionError):h.run_bounded(argv,timeout=timeout,limit=1000)
 def test_remote_command_is_pinned_no_agent_or_shell(self):
  c={**CONFIG,'ssh':{'host':'192.0.2.1','user':'monitor','key':'/private/key','knownHosts':'/private/known'}}
  argv=h.ssh_command(c);self.assertEqual(argv[0],'/usr/bin/ssh');self.assertIn('StrictHostKeyChecking=yes',argv);self.assertIn('IdentityAgent=none',argv);self.assertIn('/dev/null',argv);self.assertEqual(argv[-1],'monitor@192.0.2.1')
 def test_unknown_nested_fields_are_not_retained(self):
  s=sample();s['containers']['app']['secret']='do not retain';s['mounts']['media']['payload']='do not retain';s['extra']='do not retain'
  self.assertNotIn('do not retain',json.dumps(h.validate_sample(s,CONFIG,100000)))
 def test_critical_cpu_requires_current_contention(self):
  p=None
  for n in range(7):
   s=sample(100000+n*300);s['cpuIdle']=s['cpuTotal']*.02;p=self.step(s,p)
  self.assertEqual(p['incidents']['cpu']['severity'],'warning')
  s=sample(102100);s.update(cpuIdle=s['cpuTotal']*.02,cpuPressure=20);p=self.step(s,p);self.assertEqual(p['incidents']['cpu']['severity'],'critical')
 def test_poll_is_atomic_and_reports_malformed_remote_as_failure(self):
  with tempfile.TemporaryDirectory() as d:
   c={**CONFIG,'ssh':{'host':'192.0.2.1','user':'monitor','key':d+'/key','knownHosts':d+'/known'},'statePath':d+'/state','reportPath':d+'/report','maintenancePath':d+'/maintenance'}
   with patch.object(h,'run_bounded',return_value=json.dumps(sample())),patch.object(h.time,'time',return_value=100000):h.poll(c)
   self.assertTrue(h.read_json(c['reportPath'])['collectionOk'])
   with patch.object(h,'run_bounded',return_value='not json'),patch.object(h.time,'time',return_value=100300):h.poll(c)
   report=h.read_json(c['reportPath']);self.assertFalse(report['collectionOk']);self.assertEqual(report['lastSuccessfulAt'],100000);self.assertIn('monitor',report['incidents'])
   self.assertEqual(pathlib.Path(c['reportPath']).stat().st_mode&0o777,0o640)
 def test_invalid_maintenance_fails_closed_without_erasing_state(self):
  with tempfile.TemporaryDirectory() as d:
   c={**CONFIG,'statePath':d+'/state','reportPath':d+'/report','maintenancePath':d+'/maintenance'}
   h.atomic_json(c['statePath'],self.step(sample()));prior=pathlib.Path(c['statePath']).read_bytes();h.atomic_json(c['maintenancePath'],{'version':1,'until':9999999})
   with patch.object(h.time,'time',return_value=100000),self.assertRaises(ValueError):h.poll(c)
   self.assertEqual(pathlib.Path(c['statePath']).read_bytes(),prior)
 def test_corrupt_state_does_not_silently_rebaseline(self):
  with self.assertRaises((KeyError,ValueError)):self.step(sample(),{'version':1,'sourceId':'other'})
if __name__=='__main__':unittest.main()
