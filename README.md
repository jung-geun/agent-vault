# Agent Vault

Agent Vault는 OMP용 스킬과 Node.js CLI입니다. Obsidian 호환 vault를 프로젝트 간 메모리로 사용합니다. 기본 경로는 `~/.vault`이며, 사용자 설정과 프로젝트 자료는 이 Git 저장소가 아닌 vault에 둡니다.

## 요구 사항

- Node.js 20 이상. 런타임 의존성은 Node.js 내장 모듈뿐입니다.
- 전역 설치와 세션 규칙 연동에는 OMP가 필요합니다.
- Obsidian 앱은 선택 사항입니다. vault는 Markdown과 `.obsidian` 설정으로 구성됩니다.

## OMP 전역 설치

저장소 루트에서 실행합니다.

```sh
cd ~/code/agent-vault
npm run check
npm test
node bin/vault-cli.mjs install --global
```

설치기는 런타임 스킬 파일만 `~/.omp/agent/skills/agent-vault`와 `~/.agents/skills/agent-vault`에 복사합니다. `integrations/omp/agent-vault.rule.md`는 `~/.agents/rules/agent-vault.md`가 없거나 내용이 같을 때만 설치합니다. 다른 내용의 기존 규칙은 보존하고 경고합니다. 직접 비교하고 필요한 내용을 병합하세요.

설치 후 새 OMP 세션을 시작하고 스킬 발견을 확인합니다.

```sh
omp skill list --json
```

전역 `alwaysApply` 규칙은 매 세션 `vault_context` 도구를 호출하도록 요구합니다. 설치기는 MCP 서버 `agent-vault`를 `~/.omp/agent/mcp.json`에 등록합니다. 다른 서버와 키는 그대로 보존하며, 같은 이름의 다른 항목이 있으면 덮어쓰지 않고 경고합니다.

설치기는 OMP 확장 `integrations/omp/agent-vault-recorder.ts`도 `~/.omp/agent/extensions/agent-vault-recorder.ts`에 설치합니다. 이 확장은 사용자 입력마다 `instruction` 기록을, 파일을 수정한 턴이 끝날 때마다 `implementation` 기록을 현재 워크트리에 남깁니다. `.agent-vault-project` 마커가 있으면 프로젝트를 자동 등록하고, 마커를 `.git/info/exclude`에 추가해 로컬 설정으로 숨깁니다. exclude 갱신에 실패해도 프로젝트 기록은 계속 시도하고 별도 경고를 표시합니다. 첫 줄의 `agent-vault-recorder: managed by agent-vault install.` 표식이 있는 파일만 갱신하고, 표식이 없는 같은 이름의 파일은 보존하고 경고합니다. 프로젝트를 해석할 수 없거나 자격 증명이 감지되면 기록을 건너뛰고 경고만 표시합니다.

등록되는 도구는 다음과 같습니다.

| 목적 | 도구 |
|---|---|
| 세션 컨텍스트 | `vault_context` |
| 검색·조회·목록 | `memory_search`, `memory_read`, `memory_list` |
| 등록·갱신 | `memory_write` (`create`, `append`, `replace`; `replace`는 `expectedHash` 필요) |
| 프로젝트 | `project_resolve`, `project_list`, `project_scaffold` |
| 에이전트 | `agent_memory_read`, `agent_memory_write`, `agent_handoff` |
| QA 기록 | `log_write` |
| 단기 메모리 | `short_memory_read`, `short_memory_write` (`projects/<id>/memory.md`, 교체 시 `expectedHash` 필요) |
| 장기 메모리 | `long_memory_write` (`projects/<id>/long-term/YYYY-MM-DD-<slug>.md`, 생성 후 불변) |
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

## Git 공개 전 보안 점검

이 저장소에는 공용 스킬 코드, 템플릿, OMP 연동 규칙만 둡니다. 개인 vault, 프로젝트별 조사 자료, 사용자 선호, 마이그레이션 결과, `.env`, 인증 정보, 개인 키는 커밋하지 마세요. `.gitignore`가 일반적인 로컬 설정과 비밀 파일을 제외하지만, 공개 전에 스테이징 파일을 직접 검토하고 비밀 탐지기도 실행하세요.

아직 라이선스를 선택하지 않았습니다. 오픈소스로 배포하기 전에 라이선스를 결정하세요.
