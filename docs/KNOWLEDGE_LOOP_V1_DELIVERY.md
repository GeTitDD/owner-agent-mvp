# Owner Knowledge Loop v1.0 鈥?浜や粯鎶ュ憡

- 鏃ユ湡锛?026-11-08
- 鍒嗘敮锛歚feat/v1.3-knowledge-loop`锛堝熀浜?`main@8c14707`锛?
- pstack-pi锛歚main@c0fad96`锛坴ersion `0.2.0`锛?
- 缁撹锛氱煡璇嗛棴鐜殑鏁版嵁濂戠害銆侀噰闆嗐€佹彁鐐笺€佸鎵?楠岃瘉銆佸鐢ㄣ€佸弽棣堜笌 A/B 璇勪及宸插彲杩愯锛涚湡瀹?Pi 宸插畬鎴愪竴娆?Harvest 鍜屼竴娆?Reuse锛涘洶闅句换鍔?A/B 鏄剧ず鐭ヨ瘑澶嶇敤甯︽潵鍙祴宸紓銆俶acOS/Companion 鐭ヨ瘑鍏ュ彛瑙佸悗缁爢鍙?PR銆?

## 1. 澶嶇敤涓庤亴璐?

| 鑳藉姏 | 澶嶇敤 |
| --- | --- |
| 鐭ヨ瘑瀛樺偍 | `PersonalKnowledgeStore`锛堟柊澧?experience/usage/feedback 琛ㄤ笌 proposal meta 鍒楋級 |
| 鍊欓€?| 鐜版湁 `personal_proposals` + `reviewProposal` |
| 璇佹嵁/杩愯 | OwnerStore 鐨?job/sandbox/repair/evidence |
| 閫傜敤鎬?| `src/applicability.mjs` |
| 涓婁笅鏂?| `compiler.mjs` + `workspace-overlay.mjs` |
| 妫€绱?| `engine.retrieve` / `scopedSearch` |
| Pi | `DefaultPiSessionFactory`锛涙柊澧炲彧璇?Harvest session |
| pstack | EDAE/Reflect/Eval/decision-log 绾緥钖勯€傞厤锛涗笉鏀?Skill |

鏈柊寤?KnowledgeStore銆丆andidateStore銆丆ontext Compiler銆丄gent Harness 鎴栬皟搴﹀櫒銆?

## 2. 鏁版嵁濂戠害

- Experience锛歚sourceRunId / projectId / taskId / domainIds / observedProblem / actionSummary / observedOutcome / evidenceRefs / environment / facts / inferences / unknowns / dedupeKey`銆?
- Knowledge Candidate锛氱幇鏈?proposal payload + `meta`锛?
  - `contract=knowledge-candidate/v1`
  - `sourceExperienceIds / proposedLayer / confidence / contradictions / revision / harvestRunId / playbook=edae / steps / validationSuggestions`
- Knowledge Usage锛歚knowledgeId / revision / targetRunId / projectId / retrievalReason / applicabilityResult / contextSnapshotId / outcomeEvidenceRefs / observedBenefit / unresolvedQuestions`銆?
- Outcome Feedback锛歚usageId / outcome / observedBenefit / evidenceRefs / proposedEvolution / rationale`銆?

鑷姩鍊欓€夋案杩?`unverified`锛沘pprove 涓?verify 鏄袱涓樉寮忎汉宸ユ楠ゃ€?

## 3. 瀹炵幇妯″潡

| 鏂囦欢 | 浣滅敤 |
| --- | --- |
| `src/personal-store.mjs` | 涓夊紶 Loop 琛ㄣ€乸roposal meta銆佸箓绛?API |
| `src/knowledge-loop/contracts.mjs` | 濂戠害鏍￠獙涓庡€欓€夋槧灏?|
| `src/knowledge-loop/experience.mjs` | 浠?Sandbox/Job 閲囬泦缁忛獙 |
| `src/knowledge-loop/pi-harvest-session.mjs` | 鍙 Pi Harvest锛屽姞杞?pstack skills |
| `src/knowledge-loop/harvest.mjs` | EDAE 姝ラ銆佽瘉鎹暣鐞嗐€佸€欓€夌敓鎴?|
| `src/knowledge-loop/reuse.mjs` | 缂栬瘧涓婁笅鏂囥€乁sage 璁板綍 |
| `src/knowledge-loop/feedback.mjs` | Outcome Feedback銆佹檵鍗?闄嶇骇寤鸿 |
| `src/knowledge-loop/eval.mjs` | A/B/C Runner 涓庢寚鏍?|
| `src/knowledge-loop/decision-log.mjs` | 涓?pstack 鍚屽垪 TSV |
| `bin/knowledgectl.mjs` | collect/harvest/approve/verify/reuse/feedback |
| `adapters/pi/extension.mjs` | 缂栬瘧鏃惰褰?Usage锛坄OWNER_KNOWLEDGE_USAGE=1`锛?|
| `src/workbench-server.mjs` | 鍙 experiences/candidates/usages/loop-summary API |

## 4. 鑷姩鍖栭獙璇?

- `npm run check`锛氶€氳繃銆?
- `npm test`锛?98 tests / 195 pass / 3 skip / 0 fail锛堟柊澧?8 涓?knowledge-loop 娴嬭瘯锛夈€?
- `npm run knowledge:demo`锛氱‘瀹氭€т笁椤圭洰闂幆閫氳繃銆?
  - 4 鏉?Experience锛堜慨澶嶃€佸け璐ャ€佷袱涓€氳繃锛?
  - L3 鍊欓€?鈫?瀹℃牳/楠岃瘉
  - L2 鍊欓€?鈫?瀹℃牳/楠岃瘉
  - 3 涓」鐩鐢紝4 鏉?usage锛? 鏉℃鍙嶉
  - 鎻愬嚭 L2鈫扡1 鏅嬪崌寤鸿
- 骞傜瓑锛氬悓涓€ Run 閲嶅閲囬泦涓嶉噸澶嶏紱鍚屼竴 Experience 缁勫悎閲嶅 Harvest 杩斿洖宸叉湁鍊欓€夛紱鍚屼竴 usage key 骞傜瓑銆?
- 鏁版嵁鍏煎锛歚personal_proposals` 鑷姩澧炲姞 `meta_json`锛涙棫搴撲粛鍙墦寮€銆?

## 5. 鐪熷疄 Pi 璇佹嵁

### 5.1 鐪熷疄 Pi Run 閲囬泦

杩愯 root锛歚D:\nautilus_trader\.tmp\opencode\knowledge-acceptance-l2b`

- `scripts/acceptance/e2e-repair.mjs --level 2`锛氭簮琛ヤ竵纭畾鎬с€丼andbox provider 涓?fake锛?*淇鎻愭鐢辩湡瀹?Pi锛坓lm-5.3锛夌敓鎴?*銆?
- 淇琛ヤ竵 `c06b9867-3e2b-4c58-b8cd-f0a58eb08bac`锛宺epair run `completed/completed/pass`銆?
- 浠庡悓涓€ OwnerStore 鐩存帴閲囬泦锛?
  - `exp_7537a0d9e80f4ae0a3410fd1`锛氭簮娴嬭瘯 fail锛?
  - `exp_b36ce1405eec434d92a5ebb0`锛氫慨澶嶅悗 pass / `repaired`銆?
- 鐪熷疄 Pi Harvest锛坄harvest_313d6d093b3a4473ad7d9e47`锛変粠杩欎袱鏉?Experience 鐢熸垚 2 涓?project 鍊欓€夛紝鍖呭惈锛?
  - 鈥滆鏁板紡閲嶈瘯 off-by-one锛歛ttempts 涓烘€绘鏁版椂锛屾帓浠栦笂鐣屽繀椤荤瓑浜?attempts鈥濓紱
  - 璇佹嵁寮曠敤婧?淇 stdout銆佷袱涓ˉ涓?diff銆乻napshot manifest 鍝堝笇涓€鑷存€с€?
- 璇存槑锛氳楠屾敹鐨?sandbox 缁撴灉涓?fake provider 鍥哄畾杈撳嚭锛涙ā鍨嬫彁妗堜笌璇佹嵁閾炬槸鐪熷疄鐨勶紝鏈妸瀹冨啓鎴愮湡瀹?Docker 鎵ц銆?

### 5.2 鐪熷疄 Harvest + 璺ㄩ」鐩€欓€?

杩愯 root锛歚D:\nautilus_trader\.tmp\opencode\knowledge-loop-demo-real`

- 杈撳叆 3 鏉?Experience锛歞emo-a 婧愬け璐ャ€乨emo-a 淇閫氳繃銆乨emo-b 閫氳繃锛坒ixture Sandbox锛夈€?
- 妯″瀷锛歚zai-coding-cn/glm-5.3`銆?
- Harvest run锛歚harvest_53ef6399aa3d4b1582c0d201`銆?
- 浜у嚭 applied 鍊欓€夛細`4f7d5e76-0f96-49ec-a58c-0c1e9e8decf8`锛屼富寮?`attempts - 1` 鈫?`attempts`銆?
- Owner 瀹℃牳鍚庡崟鍏冿細`personal.80f1093f88644ea8a85a50ff`锛宺evision 2锛宍verified`銆?

### 5.3 鐪熷疄 Reuse

- 椤圭洰 B 缂栬瘧浠诲姟锛歚retry withRetry attempts loop off-by-one`銆?
- `dynamicContext` 鍖呭惈 verified 鍗曞厓锛屾爣绛?`[applied layer; verification=verified; ELIGIBLE]`銆?
- 璁板綍 usage锛歚targetRunId=run-demo-b-pass`锛宍contextSnapshotId=407db8...`锛宍applicabilityResult=applicable`銆?
- 璇佹嵁鏂囦欢锛歚real-reuse-b.json`銆?

## 6. A/B/C 璇勪及

鍥哄畾浠诲姟銆佹ā鍨?`zai-coding-cn/glm-5.3`銆佸悓涓€ fixture 涓庢祴璇曞懡浠ゃ€?

### 6.1 閫氱敤浠诲姟

| Variant | runs | success | rework | irrelevant injection | misapplication | knowledge tokens |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Baseline | 3 | 3/3 | 0 | 0 | 0 | 0 |
| Knowledge | 2 | 2/2 | 0 | 0 | 0 | 569 |
| Forced misleading | 1 | 1/1 | 0 | 0 | 0 | 29 |

缁撹锛氬湪寮哄熀绾夸笂锛宧elpful 浠诲姟娌℃湁鎴愬姛鐜囨彁鍗囷紱irrelevant 浠诲姟鍦ㄧ浉鍏虫€ч槇鍊间慨澶嶅悗娉ㄥ叆 0 鏉★紱forced misleading 琚ā鍨嬪拷鐣ワ紝鏈€犳垚澶辫触銆?*涓嶅绉伴€氱敤浠诲姟涓婄殑鏁堟灉鎻愬崌銆?*

### 6.2 鍥伴毦浠诲姟锛堜笉鍙粠婧愮爜鎺ㄦ柇鐨勯」鐩害瀹氾級

浠诲姟锛歠ixture 榛樿 `attempts = 1`锛屾祴璇曡姹?7 娆★紱鐭ヨ瘑鏄庣‘鈥滆 fixture 瀹舵棌榛樿灏濊瘯娆℃暟涓?7鈥濄€?

| Variant | success | rework | knowledge refs |
| --- | ---: | ---: | ---: |
| Baseline | **false** | 1 | 0 |
| Knowledge | **true** | 0 | 3 |

璇佹嵁锛歚eval-hard-report.json`锛坆aseline exit 1锛宬nowledge exit 0锛夈€傝繖鏄湰杞敮涓€鍙敮鎸佺殑鈥滅煡璇嗗鐢ㄦ湁鏁堚€濈粨璁猴紝涓斿彧鍦ㄦ槑纭€傜敤绾﹀畾鐨勪换鍔′笂鎴愮珛銆?

## 7. 涓夎疆杩唬

1. **閲囬泦/鍊欓€夋槧灏?*锛氫慨澶?evidenceRefs 鎺掑簭瀵艰嚧鍘婚噸澶辨晥锛涢檺鍒跺崟椤圭洰鍊欓€変负 L3锛涘彂鐜?remove candidate meta 闇€瑕佹墿灞?proposal schema銆?
2. **Harvest 璇佹嵁璐ㄩ噺**锛氱湡瀹?Pi 绗竴杞彧鐪嬪埌 patch 璺緞锛屼骇鍑烘祦绋嬪瀷鍊欓€夛紱鍔犲叆 proposal diff 涓庘€滄妧鏈満鍒朵紭鍏堚€濇彁绀哄悗锛岀湡瀹炲€欓€夋纭瘑鍒?`attempts - 1`銆?
3. **妫€绱㈢簿搴?Eval**锛氬彂鐜版棤鍏充换鍔℃敞鍏?0.2 鍒嗙殑 claim 鍛戒腑锛涙妸鏈湴鐭ヨ瘑鐩稿叧鎬ч槇鍊兼彁楂樺埌 3锛宨rrelevant injection 闄嶄负 0锛涙柊澧炲洶闅句换鍔?A/B锛屽緱鍒?baseline fail 鈫?knowledge pass銆?

## 8. 宸茬煡闄愬埗

- 鐪熷疄 A/B 鍙湪鍗曚竴妯″瀷锛坓lm-5.3锛変笌灏忓瀷 fixture 涓婂畬鎴愶紱鏍锋湰閲?1锛屼笉鑳藉鎺ㄤ负鏅亶鏁堟灉銆?
- 鈥滅煡璇嗘湁鏁堚€濆彧鍦ㄢ€滈」鐩害瀹氫笉鍙粠婧愮爜鎺ㄦ柇鈥濈殑鍥伴毦浠诲姟涓婅璇佹槑锛涢€氱敤 retry 浠诲姟 baseline 宸插畬鎴愩€?
- pstack 鍙綔涓虹邯寰嬩笌 Skill 鍔犺浇鏉ユ簮锛涙湭鑷姩淇敼 pstack Skill锛屾湭璋冪敤 Cursor `/loop`銆?
- Companion 鐭ヨ瘑鍏ュ彛鍦ㄥ爢鍙犲垎鏀疄鐜帮紱macOS 鏈獙璇併€?
- `node-smoke` profile 鍥哄畾锛岀湡瀹為」鐩渶鎻愪緵 `tests/sandbox-smoke.test.mjs`銆?
- Token 鏁颁负淇濆畧浼扮畻锛屼笉鏄?provider 璁¤垂鍊笺€?

## 9. 澶嶇幇

```bash
npm run check
npm test
npm run knowledge:demo -- --root <dir>
# 鐪熷疄 Pi锛堥渶妯″瀷鍑嵁锛?
node bin/knowledgectl.mjs harvest --owner-db <dir>/owner.sqlite --knowledge-db <dir>/knowledge.sqlite \
  --project demo-a --experience <id> --experience <id> --allow-model
node bin/knowledgectl.mjs approve --knowledge-db <dir>/knowledge.sqlite --proposal <id>
node bin/knowledgectl.mjs verify --knowledge-db <dir>/knowledge.sqlite --knowledge-id <id> --evidence sandbox:<id>
node bin/knowledgectl.mjs reuse --cwd <project> --project <id> --task "..." --target-run <run>
node scripts/knowledge-loop/eval-real.mjs --root <dir> --knowledge-id <id> --allow-model
node scripts/knowledge-loop/eval-hard.mjs --root <dir> --allow-model
```

## 10. DoD 瀵圭収

| DoD | 鐘舵€?|
| --- | --- |
| 鐪熷疄 Pi Run 鍙噰闆嗕负 Experience | 鉁咃紙鐪熷疄 Harvest 浣跨敤浜嗙湡瀹炶繍琛岃瘉鎹紱閲囬泦鍣ㄦ湰韬篃鏀寔 Job/Sandbox锛?|
| pstack 椹卞姩 Harvest 鐢熸垚缁撴瀯鍖栧€欓€?| 鉁咃紙鍔犺浇 pstack skills锛孍DAE/Reflect/decision log锛?|
| 鍊欓€夎繘鍏ョ幇鏈夌煡璇嗗簱 | 鉁咃紙proposal 鈫?unit锛?|
| 鏌ヨ/淇/楠岃瘉/鎷掔粷/鏉ユ簮杩借釜 | 鉁咃紙鐜版湁 PersonalKnowledgeStore + 鏂板瑙嗗浘锛?|
| L3鈫扡2/L1 鏅嬪崌寤鸿 | 鉁咃紙涓?涓変釜椤圭洰姝ｅ弽棣堣Е鍙?promotion proposal锛涘崟鍏冩祴璇?demo锛?|
| 鏂颁换鍔℃绱㈠苟浣跨敤鐭ヨ瘑 | 鉁咃紙鐪熷疄 Reuse锛宑ontext + usage锛?|
| 澶嶇敤缁撴灉鍙嶅悜鍏宠仈鐭ヨ瘑 | 鉁咃紙feedback 鈫?usage 鈫?knowledge锛?|
| 閿欒/鏃犲叧/鍐茬獊璐熷悜娴嬭瘯 | 鉁咃紙闃堝€间慨澶嶃€乫orced misleading銆乧onflict status锛?|
| 涓嶉噸澶嶉€犲瓨鍌?Harness | 鉁?|
| 鐪熷疄 Pi 鎻愮偧妗堜緥 | 鉁咃紙harvest_53ef...锛?|
| 鐪熷疄 Pi 澶嶇敤妗堜緥 | 鉁咃紙real-reuse-b锛?|
| 涓夎疆 Eval/璐ㄩ噺杩唬 | 鉁咃紙瑙?搂7锛?|
| 妗屽疇鐭ヨ瘑鍏ュ彛 | 鈴?鍫嗗彔 Companion PR |
| 瀹夎/鍥炴粴璇存槑 | 鉁咃紙CLI + docs锛?|

