# Samcheok HUB backend

## 실행

```powershell
npm install
Copy-Item .env.example .env
npm start
```

기본 주소는 `http://localhost:3000`입니다.

## AWS EC2 배포

이 프로젝트는 EC2 한 대에서 Node.js 서버와 `samhub.html`을 함께 서비스할 수 있습니다.

1. EC2에 Node.js 20 이상을 설치하고 프로젝트를 업로드합니다.
2. 보안 그룹에서 HTTP 80 또는 사용할 포트를 허용합니다.
3. 서버 폴더에서 환경 파일을 만들고 운영용 값을 입력합니다.

```powershell
Copy-Item .env.example .env
npm install --omit=dev
npm start
```

4. 브라우저에서 `http://EC2_PUBLIC_IP:3000`으로 접속합니다. HTML은 같은 서버에서 제공되며 API 주소도 자동으로 현재 주소의 `/api`를 사용합니다.

운영 환경에서는 `JWT_SECRET`, `ADMIN_PASSWORD`를 반드시 긴 랜덤 문자열로 변경하고, EC2 재시작 후에도 실행되도록 PM2나 systemd를 사용하세요. 현재 데이터와 업로드 파일은 `server/data`와 `server/uploads`에 저장되므로 EBS 백업도 설정해야 합니다.

`CORS_ORIGIN`에는 실제 프론트 도메인만 입력하세요. 여러 도메인은 쉼표로 구분합니다.

서버 상태 확인 주소는 `GET /health`입니다.

## 관리자 계정

`.env`의 `ADMIN_USERNAME`, `ADMIN_PASSWORD`를 반드시 변경하세요. 기본 개발용 값은 `admin` / `change-this-password`입니다.

## 이메일

승인·반려 이메일은 `.env`에 SMTP 설정을 입력하면 발송됩니다. SMTP를 설정하지 않으면 승인 기능은 동작하지만 이메일은 발송되지 않습니다.

## 주요 API

- `POST /api/auth/signup` (multipart: `studentCard`)
- `POST /api/auth/login`
- `GET /api/teachers` (로그인 필요)
- `GET /api/categories` (로그인 필요)
- `POST /api/admin/categories` (관리자 전용)
- `PATCH /api/admin/categories/:id` (관리자 전용, 아이콘·색상 변경)
- `DELETE /api/admin/categories/:id` (관리자 전용)
- `GET /api/admin/applications`
- `PATCH /api/admin/applications/:id/approve`
- `PATCH /api/admin/applications/:id/reject`
- `GET/POST /api/posts`
- `DELETE /api/posts/:id`
- `POST /api/posts/:id/comments`
- `DELETE /api/posts/:postId/comments/:commentId`
