# Agent Vault

[![skills.sh](https://skills.sh/b/jung-geun/agent-vault)](https://skills.sh/jung-geun/agent-vault)

**에이전트와 개발 환경이 바뀌어도 사용자·프로젝트·업무 지식을 이어서 활용하기 위한 메모리 하네스입니다.**

단순히 대화를 저장하는 대신, 지식의 의미·관계·조건·도출 근거를 기록하고 새로운 증거에 따라 점진적으로 개선합니다. 특정 하네스에 종속되지 않도록 스킬, MCP 서버, CLI를 제공하며, Claude Code·Codex·Cursor·OMP 등 스킬과 MCP를 지원하는 환경에 연결할 수 있습니다. OMP는 지원 환경 중 하나이며 필수 요소가 아닙니다.

## 설치

Node.js 24 LTS를 권장합니다. 다음 명령에서 사용할 에이전트를 선택하세요.

```sh
npx skills add jung-geun/agent-vault -g
```

`-g`는 사용자 전역 설치입니다. 설치 소스에는 npm 패키지명이 아닌 GitHub 저장소명 `jung-geun/agent-vault`를 사용합니다.

스킬 설치 후 아래 사용 방법에 따라 프로젝트와 MCP를 연결하면 됩니다. CLI 예시는 npm 게시 상태와 무관하게 사용할 수 있는 GitHub 릴리스 `v1.1.1`로 고정합니다. 자체 설치 TUI는 `npx -y github:jung-geun/agent-vault#v1.1.1`로 실행하세요.

공식 [Skills 커스터마이징](https://www.skills.sh/docs/customize)에 따라 `skills.sh.json`으로 저장소 소개를 구성합니다. 이 설정은 skills.sh의 표시만 바꾸며, 설치 방식이나 MCP·hooks를 자동으로 변경하지 않습니다.

## 주요 기능

- **맥락 유지:** 사용자 선호, 프로젝트 결정, 작업 상태를 저장하고 다음 태스크에서 불러옵니다.
- **메모리 분리:** 전역·프로젝트·역할별 범위를 나누고 단기 작업 상태와 장기 지식을 구분합니다.
- **근거 기반 개선:** 사용자의 정정을 재검토 신호로 삼고, 기존 지식과 새 증거를 비교합니다. 근거가 부족하면 갱신을 보류합니다.
- **태스크 경계에서 정리:** 사용 횟수와 노후화는 검토를 예약할 뿐입니다. 진행 중인 태스크를 끊지 않고 정상 종료·유휴 상태에서 검토된 변경을 적용합니다.
- **로컬 저장:** 문서와 단기 메모리는 Markdown, 장기 메모리와 검수 이력은 SQLite에 저장합니다. Obsidian으로 Markdown 문서를 볼 수도 있습니다.
- **주간 기록:** 지식·로그·인수인계를 `YYYY-WW.md` 하나에 날짜·요일별로 묶습니다. 진행 중인 태스크는 월요일이 지나도 시작한 업무 주차에 남고, SQLite에서는 날짜·키워드로 조회합니다.
- **사용자 persona:** 질문·코딩·업무 지시·업무 시간 패턴을 근거와 함께 관리해 응답과 질문 방식을 조절합니다. 현재 요청이 항상 우선하며 관찰을 사실이나 권한으로 취급하지 않습니다.
- **선택적 팀 공유:** 명시적으로 설정한 팀 저장소만 사용하며 개인 메모리를 자동으로 공유하지 않습니다.

## 사용 방법

### 1. 프로젝트 연결

사용할 Git 프로젝트 폴더에서 실행합니다. `my-project`를 프로젝트 식별자로 바꾸세요.

```sh
npx -y github:jung-geun/agent-vault#v1.1.1 setup --mode manual --project my-project --harness generic
```

기본 저장 위치는 `~/.vault`입니다. `generic`은 공통 환경용 설정이며, 환경별 설정을 분리하려면 `claude`, `codex`, `omp`를 지정할 수 있습니다.

### 2. MCP 서버 연결

사용 중인 에이전트에 `agent-vault`라는 stdio MCP 서버를 등록합니다. 실행 명령과 인자는 다음과 같으며, 설정 파일 형식은 각 환경에 맞게 적용하세요.

```json
{
  "command": "npx",
  "args": ["-y", "--package=github:jung-geun/agent-vault#v1.1.1", "vault-mcp"]
}
```

스킬 설치만으로 MCP나 hooks가 자동 연결되지는 않습니다. OMP에서는 `npx -y github:jung-geun/agent-vault#v1.1.1 install --global`로 MCP·규칙·hooks 연동을 설치할 수 있습니다.

### 3. 에이전트에게 요청

MCP 연결 후에는 자연어로 요청하면 됩니다.

> 이 프로젝트의 이전 결정과 진행 중인 작업을 불러와 줘.
>
> 이번 결정의 이유와 검증 결과를 프로젝트 메모리에 남겨 줘.
>
> 이전 기록과 다른 결과가 나왔어. 기존 근거와 새 증거를 비교해서 다시 평가해 줘.

에이전트는 `vault_context`로 맥락을 읽고 메모리 도구로 검색·기록·재검토합니다. vault 파일을 직접 편집하는 대신 제공된 도구를 사용합니다.

### 4. 태스크 종료 시 정리

자동 정리를 사용하려면 환경의 **태스크 시작 hook**에 `memory_task_start`를, **태스크 종료 hook**에 반환된 `taskId`를 전달하는 `memory_task_end`를 연결합니다. 정상 완료에는 `completed: true`, 취소·오류에는 `completed: false`를 사용합니다. 매 응답 턴을 태스크 완료로 취급하지 마세요.

각 태스크 시작 시 그 태스크의 새 `taskId`로 `vault_context`를 호출해 맥락과 준비된 검수 항목을 읽습니다. hooks를 지원하지 않는 환경에서는 실제 작업이 끝난 유휴 시점에 `memory_sleep`을 명시적으로 호출할 수 있습니다.

### 5. 주간 메모리와 persona 설정

```sh
npx -y github:jung-geun/agent-vault#v1.1.1 config --markdown-months 3 --timezone Asia/Seoul --workday-start 09:00
npx -y github:jung-geun/agent-vault#v1.1.1 memory query --project my-project --from 2026-11-01 --to 2026-11-30 --query "배포"
npx -y github:jung-geun/agent-vault#v1.1.1 persona
```

주차는 월~일의 ISO 주차(`2026-47`)이며, 업무일 시작 이전은 이전 업무일로 계산합니다. 기본값은 시스템 시간대·09:00입니다. 하위 태스크는 `parentTaskId`, 중단된 작업의 재개는 `resumeTaskId`로 이전 업무 주차를 이어갑니다.

Markdown 보존 기간은 **1~6개월**이며 기본 3개월입니다. 기간이 지난 내용은 생성된 주간 Markdown에서만 정리하고 SQLite 기록은 남깁니다. 직접 수정한 Markdown은 덮어쓰거나 삭제하지 않습니다.

persona는 `persona_observe`로 관찰을 쌓고 `persona_read`·`persona_resolve`로 검토합니다. 명시적 선호와 잠정적 패턴을 구분하며, 변경은 정상 태스크 종료 후 유휴 시점에 반영합니다. `config --persona off`로 수집과 컨텍스트 반영을 끌 수 있습니다.

기존 일자별 기록은 `memory migrate --project my-project`로 SQLite에 가져옵니다. 가져온 원본까지 정리하려면 유휴 상태에서 **명시적으로** `--prune-legacy`를 추가하세요. 내용 보존을 확인한 날짜별 원본만 제거하며, 변경된 파일과 역할별 문서는 유지합니다. 업그레이드 후에는 MCP 서버를 재시작하세요.

도구 계약과 세부 운영 규칙은 [SKILL.md](SKILL.md)를 참고하세요.
