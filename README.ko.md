# Agent Vault

[English](README.md) | **한국어** | [日本語](README.ja.md) | [简体中文](README.zh-CN.md)

[![skills.sh](https://skills.sh/b/jung-geun/agent-vault)](https://skills.sh/jung-geun/agent-vault)

**에이전트와 개발 환경이 바뀌어도 사용자·프로젝트·업무 지식을 이어서 활용하기 위한 메모리 하네스입니다.**

단순히 대화를 저장하는 대신, 지식의 의미·관계·조건·도출 근거를 기록하고 새로운 증거에 따라 점진적으로 개선합니다. 특정 하네스에 종속되지 않도록 스킬, MCP 서버, CLI를 제공하며, Claude Code·Codex·Cursor·OMP 등 스킬과 MCP를 지원하는 환경에 연결할 수 있습니다. OMP는 지원 환경 중 하나이며 필수 요소가 아닙니다.

## 설치

Node.js 24 LTS를 권장합니다. 다음 명령에서 사용할 에이전트를 선택하세요.

```sh
npx skills add jung-geun/agent-vault -g
```

`-g`는 사용자 전역 설치입니다. 설치 소스에는 npm 패키지명이 아닌 GitHub 저장소명 `jung-geun/agent-vault`를 사용합니다.

설치 후에는 에이전트의 스킬 호출 기능을 사용하거나, 채팅에서 **“agent-vault 스킬로 이 프로젝트를 설정해 줘”**라고 요청하세요. 이후 설정과 메모리 사용을 위해 터미널에서 `npx`를 반복 실행할 필요는 없습니다.

## 주요 기능

- **맥락 유지:** 사용자 선호, 프로젝트 결정, 작업 상태를 저장하고 다음 태스크에서 불러옵니다.
- **메모리 분리:** 전역·프로젝트·역할별 범위를 나누고 단기 작업 상태와 장기 지식을 구분합니다.
- **근거 기반 개선:** 사용자의 정정을 재검토 신호로 삼고, 기존 지식과 새 증거를 비교합니다. 근거가 부족하면 갱신을 보류합니다.
- **태스크 경계에서 정리:** 사용 횟수와 노후화는 검토를 예약할 뿐입니다. 진행 중인 태스크를 끊지 않고 정상 종료·유휴 상태에서 검토된 변경을 적용합니다.
- **선택형 저장소:** 문서와 단기 메모리는 Markdown 파일로 유지합니다. 장기 메모리와 검토 이력은 기본적으로 별도 패키지 없는 SQLite에 저장하며, PostgreSQL 또는 MySQL/MariaDB를 명시적으로 선택할 수 있습니다.
- **주간 기록:** 지식·로그·인수인계를 `YYYY-WW.md` 하나에 날짜·요일별로 묶습니다. 진행 중인 태스크는 월요일이 지나도 시작한 업무 주차에 남습니다. 설정한 데이터베이스에서 날짜·키워드로 조회할 수 있습니다.
- **사용자 persona:** 질문·코딩·업무 지시·업무 시간 패턴을 근거와 함께 관리해 응답과 질문 방식을 조절합니다. 현재 요청이 항상 우선하며 관찰을 사실이나 권한으로 취급하지 않습니다.
- **선택적 팀 공유:** 명시적으로 설정한 팀 저장소만 사용하며 개인 메모리를 자동으로 공유하지 않습니다.
- **순위 기반 회상과 상태 점검:** `agent-vault recall`은 외부 검색 서비스 없이 키워드로 작업 설명에 맞는 메모리의 순위를 매깁니다. 선택 기능인 자동 회상은 Claude Code와 Codex 프롬프트에 배경 맥락으로만 덧붙이며 지시로 취급하지 않습니다. `agent-vault status`는 개수, 검토 대기열, 문제별 해결 방법을 알려 줍니다.
- **정규식·유사도·로컬 임베딩 검색:** 검색은 `regex`와 `similar` 모드를 지원하고 상위 5개(최대 10개)를 돌려줍니다. `similar`는 내 컴퓨터에서 실행되는 작은 임베딩 모델(Ollama 또는 LM Studio, 루프백 전용)이 있으면 이를 사용하고, 없으면 문자 유사도로 동작하므로 모델 없이도 쓸 수 있습니다. `similar`로 검색할 때만 임베딩합니다. 한국어 등 영어가 아닌 메모에는 영어 전용 모델 대신 다국어 모델(예: `granite-embedding:278m`)을 쓰세요.
- **태그·링크 정리:** `vault-cli tidy`는 태그와 링크를 점검해 철자만 다른 중복 태그, 단수·복수, 오타로 보이는 태그, 서로 겹치는 태그를 찾고 깨진 링크·모호한 링크·고아 노트를 보고합니다. `--plan`으로 정리 계획을 미리 보고, `--apply`는 `doc_write`가 교체할 수 있는 노트만 백업과 함께 수정하며(`--undo`로 복원), 저널·`user/`·SQLite 메모리는 보고만 합니다. `diagnose`가 30일마다 실행을 안내합니다.

## 사용 방법

아래는 **에이전트에게 보내는 요청**입니다. 터미널 명령이 아니며, `/agent-vault` 같은 호출 문법은 해당 환경이 지원할 때만 사용합니다.

| 요청 예시 | 동작 |
| --- | --- |
| `agent-vault setup` | 현재 프로젝트와 저장소를 설정하고, 사용하는 환경의 로컬 MCP 연결을 진행합니다. |
| `agent-vault install` | 이미 설치한 스킬의 MCP 연결을 등록하거나 복구합니다. |
| `agent-vault status` | 스킬·MCP·프로젝트·태스크 hooks의 연결 상태를 확인합니다. |
| `agent-vault recall 지난주 배포 결정` | 날짜·키워드로 기록을 찾아 근거와 함께 답합니다. |
| `agent-vault remember 이번 결정과 이유` | 작업 상태나 장기 지식으로 구분해 기록합니다. |
| `agent-vault review 이전 기록과 다른 결과가 나왔어` | 기존 근거와 새 증거를 비교해 재검토합니다. |
| `agent-vault persona 내 응답 선호를 보여 줘` | 적용 중인 선호와 검토할 관찰을 보여 줍니다. |
| `agent-vault config 주간 Markdown은 3개월, 업무 시작은 09:00` | 요청한 보존 기간과 업무 시간 설정을 적용합니다. |

### MCP는 내부 동작 방식입니다

**스킬은 에이전트의 명령 안내이며, 저장·검색·검수는 로컬 MCP 서버가 담당합니다.** 에이전트가 설치된 번들의 CLI로 초기 설정을 수행하고, 하네스는 같은 번들의 MCP 서버를 Node로 실행합니다. 사용자가 매번 실행하거나 패키지를 다시 다운로드하는 구조가 아닙니다.

최초 연결에 권한 승인이나 에이전트 재시작이 필요한 환경은 한 번 안내합니다. MCP나 hooks를 자동 등록할 수 없는 환경에서는 필요한 단계와 제한을 설명하며, 연결되지 않은 상태를 완료로 표시하지 않습니다.

### 선택 사항: SQL 저장소

SQLite에는 별도 npm 패키지나 설정이 필요 없습니다. SQL을 사용하려면 저장소 하나에 전용 빈 데이터베이스를 준비하세요. PostgreSQL 14 이상(UTF-8), MySQL 8.0.17 이상 또는 MariaDB 10.6 이상을 지원합니다. 데이터베이스 계정에는 읽기·쓰기와 테이블·인덱스·트리거·루틴 생성 권한이 필요합니다. 선택한 드라이버만 설치된 `bin/`과 `lib/`가 있는 디렉터리에 설치하세요.

```sh
npm install --prefix /absolute/path/to/agent-vault --no-save --no-package-lock pg@8
# MySQL 또는 MariaDB를 사용할 때:
npm install --prefix /absolute/path/to/agent-vault --no-save --no-package-lock mysql2@3
```

`AGENT_VAULT_DB_DRIVER`를 `postgres`, `mysql`, `mariadb` 중 하나로 지정하세요. 연결 URL은 `AGENT_VAULT_DB_URL` 또는 `AGENT_VAULT_DB_URL_FILE`로 전달합니다. 대신 드라이버와 환경 변수 이름 또는 자격 증명 파일 경로만 설정에 저장할 수도 있습니다.

```sh
vault-cli config --db-driver postgres --db-url-file /absolute/private/path/vault-dsn
```

자격 증명 파일은 소유자만 접근할 수 있어야 하며 연결 URL 한 개만 포함해야 합니다. URL 자체를 명령 인자나 저장소 설정에 입력하지 마세요. CLI, MCP 서버, 모든 태스크 hooks에 동일한 설정을 사용하세요. 로컬 외 네트워크에서는 서버를 검증하는 TLS를 사용하세요. PostgreSQL은 `sslmode=verify-full`, MySQL/MariaDB는 `ssl=true`를 지정합니다. 자세한 내용은 [저장소 사양](spec.md#1b-storage-configuration-and-cutover)을 참고하세요.

기존 SQLite 데이터베이스를 옮기려면 쓰기를 수행하는 프로세스를 모두 중지한 뒤 SQLite 파일이 있는 호스트에서 실행하세요.

```sh
vault-cli memory migrate-db --path /absolute/path/to/vault --dry-run
vault-cli memory migrate-db --path /absolute/path/to/vault
vault-cli memory diagnose --path /absolute/path/to/vault
```

첫 명령은 대상에 연결하지 않고 테이블별 개수를 표시합니다. 복사하려면 빈 SQL 저장소가 필요합니다. SQLite 원본과 Markdown 파일은 수정하지 않습니다. 원본을 백업으로 보존하고 SQL 설정으로 클라이언트를 다시 시작하세요.

팀 SQL은 별도로 활성화하며 전용 데이터베이스를 사용합니다. `vault-cli config --team-db-driver postgres|mysql|mariadb --team-id <id>`로 설정하세요. 기존 팀 파일은 `memory migrate-db --team --from-sqlite <path>`로 복사합니다.

### 메모리는 태스크 경계에서 갱신합니다

업무 주차는 월~일 기준이며, 진행 중인 태스크는 주가 바뀌어도 원래 주차를 유지합니다. Markdown은 설정한 **1~6개월**만 보관하며 데이터베이스 기록은 계속 조회할 수 있습니다.

persona와 검토된 메모리 변경은 정상 태스크 종료 후 유휴 시점에 반영합니다. hooks가 없는 환경에서는 작업을 마친 뒤 `agent-vault maintain`을 요청할 수 있습니다. 기존 일자별 파일은 `agent-vault migrate`로 가져오며, 원본 삭제는 별도의 명시적 요청이 있어야 합니다.

### hooks가 동작하는 시점과 도구별 역할

OMP, Claude Code, Codex에서는 hooks가 프롬프트를 보낼 때 태스크를 시작하고, 사용자 지시와 파일을 수정한 턴을 기록하며, 에이전트가 끝나면 태스크를 닫습니다. 에이전트에게 `agent-vault install`을 요청하면 설정해 주며, Claude Code와 Codex는 `vault-cli hooks install --host claude|codex`를 실행합니다. Codex는 이후 `/hooks`에서 hooks를 한 번 검토하고 신뢰해야 합니다. 유지보수와 persona 갱신은 태스크가 정상 완료되고 다른 태스크가 진행 중이지 않을 때만 실행됩니다. Cursor 같은 다른 환경에는 hooks가 설치되지 않으며 `agent-vault maintain` 요청으로 대신합니다. 정확한 이벤트와 시점, 모든 MCP 도구, 실제로 검증한 범위, 실패 시 동작은 **[spec.md](spec.md)**를 참고하세요.

세부 도구 계약은 [SKILL.md](SKILL.md)를 참고하세요. 공식 [Skills 커스터마이징](https://www.skills.sh/docs/customize)은 저장소 소개 화면에 적용되며, 실행 중인 에이전트의 명령이나 hooks를 대신 등록하지는 않습니다.
