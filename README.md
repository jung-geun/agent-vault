# Agent Vault

Agent Vault는 코딩 에이전트용 MCP 서버, OMP 스킬과 Node.js CLI입니다. 사용자·프로젝트·작업 지식을 근거에 따라 유지하고 재검토합니다. 문서와 단기 메모리는 Obsidian 호환 Markdown으로, 장기 메모리와 피드백·검수 이력은 SQLite로 관리합니다. 기본 경로는 `~/.vault`이며 사용자 설정과 메모리는 이 Git 저장소가 아닌 vault에 둡니다.

## 요구 사항

- Node.js 22.x는 22.13 이상, 23.x 이상은 23.4 이상이 필요합니다. Node.js 24 LTS를 권장합니다. 런타임 의존성은 내장 모듈뿐이며 SQLite에는 `node:sqlite`를 사용합니다.
- OMP MCP·세션 규칙·hooks 자동 연동에는 OMP가 필요합니다. 다른 에이전트에도 Skills CLI로 스킬을 설치할 수 있습니다.
- Obsidian 앱은 선택 사항입니다. vault는 Markdown과 `.obsidian` 설정으로 구성됩니다.

## 빠른 설치

### Skills CLI로 설치

Skills CLI의 에이전트 선택 화면에서 설치하려면 GitHub 저장소 이름을 사용합니다.

```sh
npx skills add jung-geun/agent-vault -g
```

`-g`는 사용자 전역 설치입니다. 생략하면 대화형 설치에서 범위를 선택할 수 있으며, `-y`를 추가하면 확인 프롬프트를 건너뜁니다. Skills CLI는 저장소 루트의 `SKILL.md`에서 `agent-vault` 스킬을 발견합니다.

`npx skills add agent-vault-skill -g`는 지원되지 않습니다. `agent-vault-skill`은 npm 패키지 이름이며, `skills add`의 소스는 npm 패키지 이름이 아니라 `owner/repo`, Git URL 또는 로컬 경로입니다. [Skills CLI 소스 형식](https://github.com/vercel-labs/skills/blob/main/docs/commands.md#source-formats)을 참고하세요.

Skills CLI의 설치 완료는 스킬 파일 설치를 뜻합니다. Agent Vault MCP 서버, vault 초기화, 하네스의 태스크 시작·종료 hooks까지 자동 구성하지는 않습니다. OMP 연동까지 설치하려면 아래 npm CLI의 `install --global`을 사용하세요. 다른 하네스의 MCP·hooks는 해당 하네스 설정에 연결해야 합니다.

### OMP 연동을 포함한 npm 설치

Node.js 24 LTS를 권장합니다. 저장소를 직접 내려받지 않고 Agent Vault 전용 설치기를 실행할 수 있습니다.

대화형 설치:

```sh
npx -y agent-vault-skill@latest
```

OMP 전역 설치를 바로 적용하거나 현재 프로젝트에만 설치하려면:

```sh
npx -y agent-vault-skill@latest install --global
npx -y agent-vault-skill@latest install --local
```

특정 버전을 고정하려면 `@latest` 대신 `@1.0.0`을 사용하세요. npm 패키지 다운로드만으로는 스킬·MCP 설정을 변경하지 않으며, 설치 명령 또는 TUI의 최종 확인 단계에서 적용합니다.

GitHub 공개 아카이브를 사용하는 대체 설치 방법:

```sh
bash -o pipefail -c 'curl -fsSL https://raw.githubusercontent.com/jung-geun/agent-vault/main/install.sh | bash'
```

GitHub 소스를 npm으로 직접 실행할 수도 있습니다:

```sh
npx -y github:jung-geun/agent-vault install --global
```

프로젝트에만 설치하려면 `--local`을 지정합니다.

```sh
bash -o pipefail -c 'curl -fsSL https://raw.githubusercontent.com/jung-geun/agent-vault/main/install.sh | bash -s -- --local'
npx -y github:jung-geun/agent-vault install --local
```

npm 배포본, 위의 `install.sh` 및 `npx github:jung-geun/agent-vault` 경로는 같은 Agent Vault CLI 설치기를 사용합니다. `npx skills add`는 별도의 Skills CLI입니다. npm 패키지는 런타임 파일을 명시적으로 포함하며, 테스트·로컬 지침·vault·자격 증명 파일은 배포하지 않습니다.

## Agent Vault 전용 설치 TUI

터미널에서 대상 하네스, 설치 범위, 설치 방법을 선택할 수 있습니다.

```sh
npx -y agent-vault-skill@latest install --interactive
```

인자 없이 터미널에서 실행하거나 `install`만 실행해도 TUI를 엽니다. 파이프·CI에서는 기존 `install --global` 또는 `install --local`을 사용하세요. 비대화형 입력에 `--interactive`를 지정하면 설치하지 않고 오류를 반환합니다.

- **대상 선택:** Universal(Codex 등), OMP, Claude Code, Cursor를 표시합니다. 검색어 입력, 방향키 이동, Space 선택, Ctrl+A 다중 선택, Enter 진행을 지원합니다.
- **설치 범위:** 현재 프로젝트 또는 사용자 전역을 선택합니다.
- **설치 방법:** Copy는 대상마다 독립 복사하고, Symlink는 `.agents/skills/agent-vault`의 지속적인 원본 복사본을 가리킵니다. 다운로드 임시 폴더에는 연결하지 않습니다.
- **최종 확인:** 설치 전 검사 결과로 대상별 갱신·연결·보존·충돌과 OMP 연동의 실제 처리 범위를 표시합니다. 승인 전에는 파일을 쓰지 않습니다. Ctrl+C로 취소하거나 이전 단계로 돌아갈 수 있습니다.

TUI 설치에는 Universal 원본이 포함됩니다. OMP 전역 설치를 선택했을 때만 OMP MCP·규칙·hook 연동을 설치합니다. 다른 하네스는 스킬 파일을 설치한 뒤 해당 하네스의 MCP와 태스크 시작·종료 hook을 연결해야 합니다. 기존 디렉터리나 다른 프로그램의 심볼릭 링크를 안전하게 전환할 수 없으면 보존하고 충돌을 알립니다.

기존 OMP가 복사 방식으로 설치되어 있으면 TUI는 갱신 가능한 Copy를 기본값으로 제안합니다. 명시적으로 Symlink를 선택한 경우 기존 디렉터리를 삭제하지 않으며, 보존되는 대상과 건너뛰는 OMP 연동을 확인 화면에 표시합니다.

외부 보안 검사는 자동으로 수행하지 않으며, 검사하지 않은 대상을 안전하다고 표시하지 않습니다. 자동화에서는 `--agents omp,universal --method copy`처럼 대상을 명시할 수도 있습니다.


## OMP 전역 설치 (개발 체크아웃)

소스 수정본을 시험할 때만 저장소 체크아웃에서 실행합니다. 일반 사용자는 위의 빠른 설치 명령을 사용하세요.

```sh
cd ~/code/agent-vault
npm run check
npm test
node bin/vault-cli.mjs install --global
```

설치기는 런타임 스킬 파일만 `~/.omp/agent/skills/agent-vault`와 `~/.agents/skills/agent-vault`에 복사합니다. `integrations/omp/agent-vault.rule.md`는 `~/.agents/rules/agent-vault.md`가 없거나 내용이 같으면 설치하며, 알려진 이전 배포본의 정확한 해시와 일치하면 갱신합니다. 사용자 수정본 등 다른 내용의 기존 규칙은 보존하고 경고합니다. 직접 비교하고 필요한 내용을 병합하세요.

설치 후 새 OMP 세션을 시작하고 스킬 발견을 확인합니다.

```sh
omp skill list --json
```

전역 `alwaysApply` 규칙은 매 세션 `vault_context` 도구를 호출하도록 요구합니다. 설치기는 MCP 서버 `agent-vault`를 `~/.omp/agent/mcp.json`에 등록합니다. 다른 서버와 키는 그대로 보존하며, 같은 이름의 다른 항목이 있으면 덮어쓰지 않고 경고합니다.

설치기는 OMP 확장 `integrations/omp/agent-vault-recorder.ts`도 `~/.omp/agent/extensions/agent-vault-recorder.ts`에 설치합니다. 이 확장은 사용자 입력마다 `instruction` 기록을, 파일을 수정한 턴이 끝날 때마다 `implementation` 기록을 현재 워크트리에 남깁니다. `.agent-vault-project` 마커가 있으면 프로젝트를 자동 등록하고, 마커를 `.git/info/exclude`에 추가해 로컬 설정으로 숨깁니다. exclude 갱신에 실패해도 프로젝트 기록은 계속 시도하고 별도 경고를 표시합니다. 첫 줄의 `agent-vault-recorder: managed by agent-vault install.` 표식이 있는 파일만 갱신하고, 표식이 없는 같은 이름의 파일은 보존하고 경고합니다. 프로젝트를 해석할 수 없거나 자격 증명이 감지되면 기록을 건너뛰고 경고만 표시합니다.

OMP 확장은 Bun에서 실행되지만, 자동 기록과 idle 정리는 `bin/vault-recorder.mjs`를 Node 프로세스로 실행합니다. OMP 프로세스의 `PATH`에도 지원되는 `node`가 있어야 합니다. 프롬프트 내용은 명령줄 인자가 아니라 표준 입력으로 전달합니다.

## 명령어로 프로젝트 연결하기

에이전트에게 “Agent Vault 초기 설정 방법을 설명해 줘”라고 요청하거나 설치한 CLI에서 안내를 확인하세요. 인자 없는 `setup`은 파일을 변경하지 않습니다.

```sh
node bin/vault-cli.mjs setup

# 현재 Git 프로젝트 하나만 등록하고 프로젝트 안내를 설정합니다.
node bin/vault-cli.mjs setup --mode manual --project my-project --harness omp

# OMP가 접근하는 Git 프로젝트를 첫 사용 시 자동으로 등록합니다.
node bin/vault-cli.mjs setup --mode auto --harness omp

# Claude Code는 계속 수동 등록하도록 별도로 설정합니다.
node bin/vault-cli.mjs config --mode manual --harness claude
```

하네스 이름은 `omp`, `claude`, `codex`, `generic`입니다. 기본 모드는 `manual`이며 `.agent-vault-project` 마커 방식도 유지합니다. `auto`는 Git 체크아웃만 등록하며 홈 디렉터리 자체나 파일시스템 루트는 등록하지 않습니다. 프로젝트가 모호하면 자동으로 선택하지 않습니다.

설정은 `.agent-vault/settings.json`에 저장됩니다. 하네스별 설정이 기본 설정보다 우선합니다. MCP 호출의 `harness` 또는 서버 환경 변수 `AGENT_VAULT_HARNESS`로 하네스를 지정하세요. OMP 이외의 하네스에는 해당 하네스의 MCP 설정에서 `node /absolute/path/to/bin/vault-mcp.mjs`를 연결해야 합니다. `setup`은 외부 하네스 설정이나 팀 공유를 임의로 활성화하지 않습니다.

## 메모리 저장 범위

| 범위 | 단기 메모리 | 장기 메모리 |
|---|---|---|
| 프로젝트 공용 | `projects/<id>/memory.md` | SQLite의 project namespace |
| 프로젝트 + 역할 | `projects/<id>/agents/<role>/short-term.md` | project + role namespace |
| 전역 공용 | `shared/knowledge/memory/global-short-term.md` | global namespace |
| 전역 + 역할 | `shared/knowledge/memory/agents/<role>-short-term.md` | global + role namespace |
| 팀 | 로컬 단기 메모리와 분리 | 명시적으로 설정한 외부 저장소 |

로컬 장기 메모리, 사용 횟수, 검수 기록은 `.agent-vault/memory.db`에 저장합니다. `scope: "project"`가 기본값이며 `scope: "global"`에는 프로젝트를 지정하지 않습니다. 역할을 생략하면 공용 namespace이고 역할을 지정하면 해당 역할만 조회합니다. 역할은 검증된 사용자 신원이 아니라 호출자가 선언한 분류입니다.

기존 `.agent-vault/`가 넓은 권한으로 생성되어 있으면 현재 사용자 소유의 실제 디렉터리인 경우에만 `0700`으로 제한합니다. vault 상위 디렉터리나 다른 경로의 권한은 변경하지 않습니다.

단기 메모리는 `short_memory_read`의 `sha256`을 `expectedHash`로 넘겨 갱신합니다. 장기 메모리는 `long_memory_write`로 추가하고 `long_memory_search`와 `long_memory_read`로 조회합니다. 출처에는 `memory:<id>`를 인용합니다. 수정이 필요하면 검수 후 새 기록으로 대체하고 이전 기록을 보존합니다.

기존 Markdown 장기 메모리는 다음 명령 또는 `memory_migrate` 도구로 가져옵니다. 원본 파일을 수정하거나 삭제하지 않으며, 재실행 시 이미 가져온 내용은 건너뜁니다. 변경된 원본은 충돌로 보고합니다.

```sh
node bin/vault-cli.mjs memory migrate --project my-project
```

Obsidian 플러그인과 Bases는 Markdown 문서를 표시합니다. SQLite 장기 메모리는 MCP 도구로 조회하며 Obsidian 문서 검색에 자동으로 복제하지 않습니다.

## 근거 기반 지식 수정

교정은 **재검토 신호**이지 사용자의 대체 주장을 자동으로 채택하라는 뜻이 아닙니다. 저장된 기록 역시 영구적인 정답이 아닙니다.

- **명시적 선호·지시:** 사용자가 자신의 선호를 바꾸면 적용 범위와 상위 지침 안에서 따릅니다. 개인 선호에 외부 증명을 요구하지 않습니다.
- **사실 주장·가설:** 출처, 조건, 반증을 구분합니다. 아직 조사하지 않은 내용은 단기 작업 가설로 남깁니다.
- **관찰:** 언제, 어디서, 어떤 조건에서 일어났는지 보존합니다. 사용자가 보고한 실패는 해당 상황의 관찰로 받아들이고, 확인만 하려고 재실행하지 않습니다. 원인 조사나 수정 검증을 위한 적절한 실행은 별개입니다.
- **정책·권한:** 정책의 발행 주체와 적용 범위를 기록합니다. 메모리나 증거는 실행·공유 권한을 부여하지 않습니다.
- **파생 값·규칙:** 입력, 단위, 가정, 추론과 의존 관계를 기록합니다. 입력이 바뀌면 결론도 재검토합니다.

기존 주장과 가정을 새 주장, 지지 근거, 반대 근거와 함께 비교합니다. 적절한 경우 외부 1차 문서, 현재 프로젝트 소스, 허가된 재현·구분 검사를 확인합니다. 비공개 메모리·로그·식별자·인증 정보를 검색 서비스에 업로드하지 마세요. 공개 기술 질문으로 정제하거나 허가된 로컬 자료를 사용합니다. 근거에 접근할 수 없으면 보류하며, 동의나 출처를 만들어 내지 않습니다.

이미 저장된 로컬 장기 기록은 다음 계약으로 재검토를 요청합니다.

`memory_reconsider({scope: "project" | "global", project?, role?, memoryId, feedback, trigger?})`

`trigger`는 `user_correction`, `counterexample`, `external_evidence`, `outdated` 중 하나입니다. 원래 기록의 scope/role을 사용하고, global에는 project를 지정하지 않습니다. 사용 횟수가 임계값 미만이어도 피드백을 대기시키며 원본 사실을 변경하지 않습니다. `memory_review` 티켓에는 피드백 기록이 포함됩니다. 현재 태스크를 중단하거나 즉시 컨텍스트를 갱신하지 않습니다.

교정 요청 검수를 해결할 때는 `memory_review_resolve`에 `memoryId`와 다음 `assessment`를 제출합니다.

- `decision`: `retain`(유지), `refine`(조건 정교화), `replace`(대체), `withdraw`(철회), `unresolved`(미해결).
- `comparison`, `applicability`, `limitations`: 이전·대체 주장과 지지·반대 근거의 비교, 적용 범위, 남은 한계. 공백만으로 작성할 수 없으며 최대 길이는 각각 4000, 2000, 2000자입니다.
- `sources`: 최대 20개의 `{kind, reference, finding, stance}` 배열. `kind`는 `primary`, `project`, `execution`, `user_report`; `stance`는 `supports`, `contradicts`, `qualifies`입니다. 실제로 확인한 자료나 받은 보고만 참조합니다. `reference`와 `finding`은 공백이 아닌 내용을 포함하며 최대 길이는 각각 1000, 2000자입니다.

동작과 판단은 `keep` → `retain`, `supersede` → `refine`/`replace`, `archive` → `withdraw`, `defer` → `unresolved`로 대응합니다. 교정 요청 검수에서는 `promote`와 `skill`을 거부하므로, 먼저 원래 주장을 해결하고 별도의 검수 단계에서 승격·절차 도출을 진행합니다. 일반 검수에 assessment를 제출하면 `promote` → `replace`, `skill` → `refine`으로 대응합니다.

제출한 모든 assessment는 `unresolved`를 제외하면 출처가 최소 하나 필요합니다. 빈 sources로 `retain`이나 `withdraw`를 제출할 수 없습니다. 모든 `refine`/`replace` assessment에는 `user_report` 이외의 출처가 최소 하나 필요합니다. 텍스트의 비밀값을 검사하며 HTTP(S) 출처 URL은 유효해야 하고 인증 정보를 포함할 수 없습니다. 이는 **제출 형식 검사이지 출처의 진실성 검증이 아닙니다**. 근거가 없으면 sources를 비워 한계를 밝히고 `defer`/`unresolved`로 보류합니다.

`defer`는 이번 검수 주기를 미해결로 닫고 원본 바이트를 그대로 둡니다. 이후 평가를 포함한 해결이 이뤄질 때까지 미해결 알림을 유지합니다. 원본 보존은 기존 주장의 재인증이 아닙니다. 아직 저장하지 않은 주장이나 단기 메모리에는 억지로 “승인된 사실”을 만들지 말고 작업 가설과 조사할 항목을 기록하세요.

완료된 검수는 동일한 범위의 `memory_review({reviewId})`로 근거와 판단을 다시 읽을 수 있습니다. 개정된 기록에는 `review:<id>` 태그가 남습니다. 보류된 주장은 조회·검색의 `knowledgeReview.status: "unresolved"`와 컨텍스트의 `memoryMaintenance.unresolvedReviews`에 표시하며, 자동으로 정답 취급하지 않습니다. 제안 이후 새 피드백이 도착하면 이전 제안을 적용하지 않고 재평가를 요구합니다. 일반 사용량 검수나 스킬 도출로 이 검토를 우회할 수도 없습니다.

### 기록 템플릿과 예

기존 도구의 `content`에 다음 항목을 서술합니다. 새 그래프 API나 실행 가능한 수식 스키마가 아닙니다.

```text
의미·종류: 정확히 어떤 주장·관찰·선호·정책·파생 규칙인가?
범위: 사용자/프로젝트/역할, 환경, 버전, 시점, 허용된 사용.
주장·상태: 가설인지, 근거가 있는 결론인지, 미해결인지.
가정: 필요한 조건과 아직 모르는 조건.
관계: 실제 memory:<id>/문서 경로와 지지·반박·조건부·의존·대체 관계.
도출: 입력, 단위, 추론 단계와 성립 조건.
근거: 실제 출처 참조, 확인한 내용, 지지 근거와 반증.
한계: 접근 불가 자료, 미검증 환경, 낡은 입력, 비공개 범위.
수정 판단: 유지/정교화/대체/철회/미해결과 다시 볼 의존 결론.
```

다음은 판단 방식의 가상 예이며 실제 검증 결과가 아닙니다.

- **기존 주장 유지:** “이 버전은 API를 지원한다”는 기록에 사용자가 호출 실패를 보고하고 “API가 없다”고 제안합니다. 실패 보고는 보존합니다. 현재 소스와 해당 버전의 1차 문서가 지원을 보이고 실패가 권한 조건에 해당하면, 원래 범위의 지원 주장을 유지하고 권한 조건을 따로 기록합니다.
- **조건부 정교화:** “항상 재시도한다”는 기록에 취소 후 재시도하지 않는 반례가 들어옵니다. 현재 소스와 1차 문서가 특정 일시 오류·취소 전 조건을 보이면 그 조건으로 정교화합니다. “절대 재시도하지 않는다”로 뒤집지 않습니다.
- **외부 근거 없음:** 새 플랫폼 한도를 주장하지만 원문에 접근할 수 없고 로컬 근거도 없으면 `defer`/`unresolved`로 보류합니다. 원본과 한계를 보존하고 새 수치를 사실로 확정하지 않습니다.
- **의미 규칙 도출:** 프로젝트 정책의 동시 작업 예산과 소스의 작업별 고정 비용을 읽고, 단위가 같을 때 예산을 비용으로 나눈 뒤 내림해 계획 한도를 도출합니다. 두 입력과 가정을 참조합니다. 가변 비용이나 정책 변경은 재검토 사유이며 실행 권한을 뜻하지 않습니다.

검색은 기존 문서·장기 메모리 도구를 사용합니다. 전체 온톨로지, 의미 검색 런타임, 자동 그래프 추론·파생 값 재계산은 제공하지 않습니다. 모델 가중치를 재학습하거나 실행 가능한 스킬을 자동 설치하지 않습니다.

## 팀 메모리

팀 공유는 기본적으로 꺼져 있습니다. 여러 머신에서는 외부 DB 앞에 HTTP 서비스를 두고 다음 API 계약을 제공하세요. 로컬 SQLite 파일을 여러 머신의 NFS나 동기화 폴더에서 동시에 열지 마세요.

```sh
node bin/vault-cli.mjs config --team-url https://memory.example.org/ --team-id engineering --token-env TEAM_MEMORY_TOKEN
# 조회만 허용하려면 위 명령에 --read-only를 추가합니다.

# 같은 호스트의 프로세스끼리 공유하는 로컬 SQLite 파일입니다.
node bin/vault-cli.mjs config --team-file /srv/agent-memory/team.db --team-id engineering
node bin/vault-cli.mjs config --team-off
```

토큰 값은 서버 프로세스의 환경 변수에서만 읽습니다. 설정에는 환경 변수 이름만 저장합니다. HTTP 백엔드는 HTTPS 또는 루프백 HTTP를 사용하며 리다이렉트를 따르지 않습니다.

- `POST <url>/v1/memories`: `{teamId, slug?, title, content, tags, author:{project?,role?}}`를 받고 `{id}`를 반환합니다.
- `GET <url>/v1/memories/search?teamId=...&q=...&limit=...`: `{items:[{id,title,content,tags,author,updatedAt}]}`를 반환합니다.

공유하려는 호출에만 `scope: "team"`을 지정합니다. 개인·프로젝트 메모리를 자동 업로드하지 않습니다. 외부 서비스가 팀 권한과 인증을 강제해야 하며, 반환된 내용은 신뢰되지 않은 자료로 취급합니다. 팀 검수는 로컬 검수 이력만 남깁니다. 공유 기록 수정·삭제·교정은 외부 서비스의 정책을 따릅니다. `memory_reconsider`는 로컬 project/global 기록용이며, 피드백을 받았다고 외부 전송이나 팀 원본 수정을 허용하지 않습니다.

## 자동 검수와 sleep 정리

성공한 메모리·기록 도구의 읽기와 쓰기 횟수를 namespace별로 누적합니다. 기본적으로 5회, 10회, 20회, 이후 20회마다 **대기 티켓만** 만듭니다. 횟수와 노후화는 일정 신호이지 진실성·신뢰도·권한의 근거가 아닙니다. 횟수를 넘었다고 진행 중인 태스크를 중단하거나 컨텍스트를 갱신하지 않습니다. 검수 도구 자체와 실패한 쓰기는 성공 횟수로 세지 않습니다.

```sh
node bin/vault-cli.mjs config --review-thresholds 5,10,20 --stale-days 14
node bin/vault-cli.mjs memory sleep --project my-project
node bin/vault-cli.mjs memory sleep --scope global --role builder
```

단기 메모리는 작성 시각으로 노후화를 판단합니다. 읽었다고 작성 시각을 갱신하지 않습니다. 검수를 확인한 해시를 저장하므로 같은 내용의 노후화 알림을 반복하지 않되, 내용이 바뀌면 다시 검수합니다.

OMP는 프롬프트 시작 시 태스크를 등록하고 **정상 종료된 `agent_end` hook**에서 대기 작업을 처리합니다. `turn_end`, 자동 재시도·계속 실행(`willContinue`), 취소·오류는 정상 종료로 취급하지 않습니다. 동시에 진행 중인 다른 태스크가 있으면 모든 태스크가 멈출 때까지 연기합니다. 임계값에 도달하지 않았다면 종료 시에도 갱신하지 않습니다.

태스크 수행 중 제출한 `memory_review_resolve` 개선안은 즉시 적용하지 않고 저장해 둡니다. 정상 종료 시 원본 해시를 다시 확인하며, 원본이 바뀌었으면 덮어쓰지 않고 실패 사유를 기록합니다. 갱신된 컨텍스트는 다음 태스크 시작 시 읽습니다. 태스크에 필요한 명시적 메모리 기록과 작업 로그 저장은 그대로 가능합니다.

종료 시 준비된 검수 티켓은 다음 태스크의 **첫 `vault_context`**에서 `memoryMaintenance.reviewWork`로 전달됩니다. 에이전트는 원본 근거를 확인해 개선안을 제출하고, 실제 적용은 정상 종료까지 연기합니다. 같은 태스크에서 컨텍스트를 다시 읽어도 검수 지시를 반복하지 않으며, 현재 태스크에서 새로 임계값을 넘은 티켓은 전달하지 않습니다.

다른 하네스는 시작 hook에서 `memory_task_start`로 받은 `taskId`를 보관하고, 종료 hook에서 `memory_task_end({taskId, completed:true})`를 호출해야 합니다. 취소·오류에는 `completed:false`를 사용합니다. 모델의 매 턴에서 종료 도구를 호출하면 안 됩니다. 종료 이벤트를 중복 전달해도 정리를 반복하지 않습니다.

태스크를 자동으로 식별할 수 없는 하네스는 `vault_context`에 시작 hook에서 받은 `taskId`도 전달하세요. hook이 연결되지 않았으면 `memoryMaintenance.lifecycle`에 연결 필요 상태를 표시합니다. 이 경우 대기 작업을 몰래 실행하지 않으며, hook을 연결하거나 실제 태스크 종료 후 수동 `memory_sleep`을 실행해야 합니다.

- `keep`: 현재 근거로 유효성을 확인하고 검수 이력을 남깁니다.
- `archive` / `supersede`: 낡은 지식을 비활성화하거나 새 지식으로 대체하되 원본을 보존합니다.
- `defer`: 근거 부족을 미해결로 기록합니다. 이번 검수 주기를 닫되 원본은 보존하고, 이후 평가된 해결 전까지 미해결 알림을 유지합니다.
- `promote`: 단기 메모리의 해시와 출처를 연결해 검토한 장기 지식을 저장합니다.
- `skill`: 자주 활용한 지식을 검토해 재사용 가능한 절차로 저장합니다. `skill` 태그로 조회할 수 있으며 실행 가능한 스킬을 임의로 설치하지 않습니다.

스킬 후보의 활용 횟수는 명시적인 장기 메모리 조회·검색으로만 증가합니다. `vault_context`의 자동 로딩은 이 횟수를 늘리지 않으므로 세션을 반복해서 시작하는 것만으로 스킬 후보가 되지 않습니다.

`memory_sleep`은 등록된 활성 태스크가 있으면 `deferred`를 반환하고 메모리를 변경하지 않습니다. 유휴 상태이며 대기 작업이 있을 때만 정확한 중복을 정리하고 검토된 개선안을 적용합니다. 자체 LLM이나 외부 모델, 저장된 지시 코드는 실행하지 않습니다.

## 도구 전용 접근과 한계

에이전트는 메모리를 제공된 MCP 도구로만 읽고 씁니다. OMP 확장은 직접적인 파일 읽기·쓰기·검색과 탐지 가능한 shell/eval 접근을 차단합니다. 도구가 없으면 메모리 접근 불가를 알리고 중단하며 직접 파일 접근으로 우회하지 않습니다.

이 확장은 보조 방어이지 보안 샌드박스는 아닙니다. 동일한 OS 사용자에게 임의 shell/eval 권한이 있으면 모든 우회 접근을 차단할 수 없습니다. 강제 격리가 필요하면 vault를 별도 OS 계정 또는 샌드박스에 두고 MCP 서버만 접근 권한을 갖게 하세요. 다른 하네스도 동일한 접근 정책과 격리를 별도로 설정해야 합니다.


## Obsidian wiki view

Install the optional sidebar, Bases views, and reading snippet into an initialized vault:

```sh
node bin/vault-cli.mjs install --obsidian --path ~/.vault
```

Restart Obsidian, then open **Agent Vault Wiki** from the ribbon or command palette. The sidebar searches note titles, paths, and summaries; filters by project, role, and type; and shows explicit links, backlinks, provenance, and observed agent lookups. It starts with curated knowledge; choose **All note types** to include raw reports and worktree records. Open `_wiki/views/Projects.base` or `Knowledge.base` for native table/list views. The plugin does not draw a full graph or rewrite notes.
The reading snippet limits line width and hides the rendered properties block only in reading view. YAML stays unchanged and remains available in edit/source mode and the wiki sidebar.

The MCP server appends successful memory, agent-memory, project, and worktree tool events to `.agent-vault/access.jsonl`. Events contain tool, timestamp, project/role when known, relative note paths, and result counts. They do not contain search queries, note bodies, hashes, or machine paths. Counts start when the updated MCP server first runs; they do not include a person opening notes in Obsidian. Role means the role declared by `vault_context` or the tool call, not a verified agent identity. Missing provenance stays unknown or path-derived.

Set `AGENT_VAULT_DISABLE_ACCESS_LOG=1` in the MCP server process environment to stop logging. Delete `.agent-vault/access.jsonl` to reset recorded history. See [wiki view design](docs/wiki-view-design.md) for research, data limits, and rollout rationale.

등록되는 도구는 다음과 같습니다.

| 목적 | 도구 |
|---|---|
| 세션 컨텍스트 | `vault_context` |
| 검색·조회·목록 | `memory_search`, `memory_read`, `memory_list` |
| 등록·갱신 | `memory_write` (`create`, `append`, `replace`; `replace`는 `expectedHash` 필요) |
| 프로젝트 | `project_resolve`, `project_list`, `project_scaffold` |
| 에이전트 | `agent_memory_read`, `agent_memory_write`, `agent_handoff` |
| QA 기록 | `log_write` |
| 단기 메모리 | `short_memory_read`, `short_memory_write` (project/global + 역할, 교체 시 `expectedHash` 필요) |
| 장기 메모리 | `long_memory_write`, `long_memory_search`, `long_memory_read` (SQLite 또는 명시적 팀 저장소) |
| 재검토·검수·정리·이전 | `memory_reconsider`, `memory_review`, `memory_review_resolve`, `memory_sleep`, `memory_migrate` |
| 워크트리 기록 | `worktree_record`, `worktree_list` (구현, 사용자 지시, 조사를 워크트리별로 기록) |

도구는 경로 탈출, 심볼릭 링크, 자격 증명 패턴, 오래된 해시 쓰기를 거부합니다. 모호한 프로젝트는 추측하지 않고 후보만 반환합니다. 수동으로 MCP 서버를 실행하려면 `node bin/vault-mcp.mjs --path <vault>`를 사용합니다.

기본 vault가 아직 없을 때 한 번 초기화합니다.

```sh
node bin/vault-cli.mjs init
node bin/vault-cli.mjs status
```

`init`은 현재 디렉터리가 속한 Git 저장소 루트를 찾아 안내 파일을 설정합니다. 기존 `AGENTS.md`와 `CLAUDE.md`가 있으면 둘 다 관리 블록을 추가하거나 갱신하고, 둘 다 없으면 `AGENTS.md`를 만듭니다. 기존 문서는 관리 블록 밖에서 보존됩니다. 하위 디렉터리에서 실행해도 저장소 루트에 적용하며, Git 저장소 밖에서는 안내 파일 설정을 건너뜁니다. 안내 블록은 vault 파일들의 용도를 설명하고, 저장소 루트의 `.agent-vault-project`가 프로젝트 자동 등록을 허용하며 `.git/info/exclude`에 로컬로 숨겨진다는 점을 알려줍니다.

## 프로젝트 단위 설치

대상 프로젝트 루트에서 실행합니다.

```sh
node ~/code/agent-vault/bin/vault-cli.mjs install --local
```

이 명령은 대상 프로젝트의 `.omp/skills/agent-vault`에만 스킬을 설치합니다. 전역 규칙이나 프로젝트 지침은 변경하지 않습니다. 전용 스킬 디렉터리의 기존 파일은 갱신되므로 사용자 수정본이 있으면 먼저 보관하세요.

## Vault 경로 설정

CLI는 `--path <path>`를 우선 사용합니다. 없으면 다음 순서로 경로를 찾습니다.

1. `OMP_VAULT_PATH`
2. 현재 디렉터리의 `.vaultrc` 또는 `.omp/vault.json`
3. 홈 디렉터리의 `~/.vaultrc`
4. 기본값 `~/.vault`

예시:

```sh
node bin/vault-cli.mjs init --path ~/Documents/agent-vault
```

`.vaultrc`에는 vault 경로만 기록합니다. `.omp/vault.json` 형식은 `{"vaultPath":"~/Documents/agent-vault"}`입니다. 이 로컬 설정 파일은 Git에 추가하지 마세요.

## 기존 자료 마이그레이션

마이그레이션은 선택한 Markdown을 vault로 복사하며 원본 저장소는 수정하지 않습니다. 같은 경로의 기존 파일은 유지하고, 내용이 다르면 충돌로 보고합니다.

프로젝트 저장소의 OpenSpec과 지원하는 메모리를 가져옵니다.

```sh
node bin/vault-cli.mjs migrate --from-repo /path/to/project --project project-id
```

`openspec/specs/*.md`, `openspec/specs/*/spec.md`와 `MEMORY.md`, `AGENTS.md`, `RULES.md`, `.omp/AGENTS.md`, `.omp/RULES.md`를 가져옵니다. 저장소의 `package.json` 스크립트도 빌더 메모리에 기록합니다.

기존 wiki의 프로젝트 문서와 OpenSpec을 가져옵니다.

```sh
node bin/vault-cli.mjs migrate --from-wiki /path/to/source-vault
```

사용자 프로필 경로는 자동으로 추측하지 않습니다. 검토한 프로필 파일만 상대 경로로 지정하세요.

```sh
node bin/vault-cli.mjs migrate --from-wiki /path/to/source-vault --profile-source user/profile.md
```

`--profile-source`는 원본 wiki 내부의 상대 파일이어야 합니다. 원본 노트에 비밀값이나 개인 정보가 있는지 확인한 뒤 가져오세요.

가져온 링크는 먼저 검사하고 필요하면 안전한 변환을 적용합니다.

```sh
node bin/normalize-imported-links.mjs --check
node bin/normalize-imported-links.mjs --write
```

## 개발

```sh
npm run check
npm test
```

외부 패키지 의존성은 없습니다. 테스트는 Node.js 내장 테스트 러너와 임시 fixture를 사용합니다.

OMP의 실제 Bun 런타임까지 확인하려면 `AGENT_VAULT_TEST_BUN=1 node --test test/setup.test.mjs`를 실행합니다. 이 검증도 임시 HOME과 vault만 사용합니다.

## Git 공개 전 보안 점검

이 저장소에는 공용 스킬 코드, 템플릿, OMP 연동 규칙만 둡니다. 개인 vault, 프로젝트별 조사 자료, 사용자 선호, 마이그레이션 결과, `.env`, 인증 정보, 개인 키는 커밋하지 마세요. `.gitignore`가 일반적인 로컬 설정과 비밀 파일을 제외하지만, 공개 전에 스테이징 파일을 직접 검토하고 비밀 탐지기도 실행하세요.

별도의 오픈소스 라이선스는 아직 선택하지 않았습니다. npm 메타데이터는 `UNLICENSED`로 표시하며, 공개 배포가 별도의 재사용 라이선스를 부여한다는 뜻은 아닙니다.
