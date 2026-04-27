# MotiShop API

## 초기 설정

```bash
npm install
cp .env.example .env
# .env 수정 — ADMIN_PW, INNOPAY_MID 등
```

## 환경변수 (.env)

| 키 | 설명 | 기본값 |
|---|---|---|
| `ADMIN_PW` | 관리자 비밀번호 | (필수) |
| `INNOPAY_MID` | InnoPay 상점 ID (test: `arstest03m`, prod: `pgmotiph1m`) | (필수) |
| `INNOPAY_CHARGE_URL` | 자동결제 API | `https://api.innopay.co.kr/api/payAutoCardBill` |
| `INNOPAY_DELETE_BILLKEY_URL` | 빌키 삭제 API | `https://api.innopay.co.kr/api/delAutoCardBill` |
| `CORS_ORIGIN` | 허용 출처 | `https://shop.motiphysio.com` |
| `SLACK_WEBHOOK_URL` | 알림 웹훅 (옵션) | 없으면 미발송 |
| `DB_PATH` | SQLite 경로 | `./motishop.db` |
| `NOTIFY_ENABLED` | 사전 안내 발송 | `false` |
| `GITHUB_WEBHOOK_SECRET` | GitHub Webhook HMAC 시크릿 (빈 값이면 자동배포 비활성) | 없음 |
| `DEPLOY_SCRIPT_PATH` | 배포 스크립트 경로 | `/home/ec2-user/motishop-api/deploy.sh` |

## 실행

```bash
npm start               # dev
# 또는 systemd/pm2로 운영
```

## DB 백업

```bash
node backup.js          # 수동 백업 (backup/motishop-<TS>.db)
# crontab 예:
# 0 3 * * * cd /home/ec2-user/motishop-api && node backup.js >> /home/ec2-user/backup.log 2>&1
```

30일 이상된 백업은 자동 삭제됨.

## E2E 테스트 체크리스트 (InnoPay 연동)

### 사전 준비
- [ ] `.env`에 `INNOPAY_MID=arstest03m` (테스트) 설정
- [ ] 테스트 카드번호 준비 (InnoPay 제공)
- [ ] `npm start`로 서버 기동

### 플로우 1 — 신규 가입
- [ ] 랜딩에서 폼 작성 → 카드 등록 → `/api/subscribe` 호출
- [ ] DB에 `subscribers` 행 생성, `bill_key` 저장 확인
- [ ] 임시 비밀번호 발급 로그 확인
- [ ] 10원 인증 결제 InnoPay 로그 확인

### 플로우 2 — 자동결제 (수동 트리거)
```bash
node -e "require('./scheduler').processDueBillings()"
```
- [ ] `billing_logs`에 결과 기록
- [ ] 성공 시 `next_billing_date` +1개월/+1년 이동
- [ ] `status = 'active'`로 전환
- [ ] 실패 시 Slack 알림 (webhook 설정 시)

### 플로우 3 — 해지 (관리자)
- [ ] `/admin`에서 해지 버튼
- [ ] `/api/cancel` 호출 → `status = 'cancelled'`
- [ ] InnoPay 빌키 삭제 요청 발송 (`billkey_deleted = 1`)
- [ ] 로그: `[빌키삭제 ✓]`

### 플로우 4 — 해지 (셀프, 마이페이지)
- [ ] `/mypage` 로그인 → 전체 해지
- [ ] 세션 삭제 + 빌키 삭제

### 플로우 5 — 사전 안내
- [ ] DB에서 한 subscriber의 `next_billing_date`를 7일 후로 조작
- [ ] 스케줄러 수동 실행
- [ ] `notified_7d = 1` 세팅 확인 (중복 발송 방지)

### 플로우 6 — 결제 실패 재시도
- [ ] 네트워크 차단 상태에서 `chargeSubscriber` 호출
- [ ] `resultCode = 'ERR'`로 재시도 2회 후 최종 실패 로그

## 보안 체크리스트

- [ ] `.env`는 git 추적 안 함 (`.gitignore` 확인)
- [ ] `ADMIN_PW`는 강력한 랜덤값 (`openssl rand -hex 16`)
- [ ] 프로덕션 전 `INNOPAY_MID` → 실제 상점 ID로 교체
- [ ] 카드 raw 데이터는 서버 DB 저장 안 함 (billKey만 저장) — 현재 구조 ✓
- [ ] HTTPS 전 구간 ✓ (nginx)
- [ ] 세션 토큰 7일 만료 ✓
- [ ] SQL 프리페어드 스테이트먼트 사용 ✓ (SQL injection 방지)
- [ ] CORS 허용 출처 제한 ✓

## 법적/컴플라이언스

- [ ] 이용약관 동의 기록 (체크박스 + 타임스탬프 DB 저장)
- [ ] 개인정보처리방침 페이지 게시
- [ ] 환불 정책 표기 (전자상거래법)
- [ ] 자동결제 사전 안내 (7일/1일 전) — 스케줄러 플래그 구현됨, SMS/이메일 연동은 `NOTIFY_ENABLED` 플래그로 확장

## GitHub Webhook 자동 배포 (1회 설정)

`main` 브랜치에 push되면 GitHub이 EC2의 `POST /api/deploy/webhook`을 호출 → 서명 검증 → `deploy.sh` 실행 → `git pull` + `rsync` + `systemctl restart`.

### 1) 시크릿 생성
```bash
openssl rand -hex 32   # 출력값을 SECRET이라고 부르자
```

### 2) EC2 `.env`에 등록
```
GITHUB_WEBHOOK_SECRET=<위 SECRET>
```
그리고 `sudo systemctl restart motishop-api`.

### 3) `deploy.sh` 실행 권한 + sudoers 설정 (EC2)
```bash
sudo chmod +x /home/ec2-user/motishop-api/deploy.sh
sudo visudo -f /etc/sudoers.d/motishop-deploy
```
파일 내용:
```
ec2-user ALL=(ALL) NOPASSWD: /usr/bin/git, /usr/bin/rsync, /bin/systemctl restart motishop-api, /bin/systemctl is-active motishop-api
```
(경로는 `which git` / `which rsync` / `which systemctl` 결과로 맞춰주세요)

### 4) GitHub Webhook 등록
Repo → Settings → Webhooks → **Add webhook**
- Payload URL: `https://shop.motiphysio.com/api/deploy/webhook`
- Content type: `application/json`
- Secret: 위 SECRET
- Events: **Just the push event**
- Active ✓

### 5) 검증
- Recent Deliveries에서 ping 200 OK 확인
- 임의 더미 커밋 push → 배포 로그 `/home/ec2-user/deploy.log` 확인

### 비활성화
`.env`에서 `GITHUB_WEBHOOK_SECRET=` 비우고 재시작하면 503 응답.

