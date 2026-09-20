# GovBiz Frontend

사용자 클라이언트를 `frontend` 아래에서 관리하며 웹과 모바일은 독립적인 앱으로 유지합니다.

- [web](web/README.md): React·Vite 웹, 브라우저 UI·쿠키 인증·Vercel 설정
- [mobile](mobile/README.md): Expo·React Native 앱, 네이티브 UI·내비게이션·세션 보관
- [공통 패키지](packages/shared/): 웹·모바일이 공유하는 업무 모델·API 계약·응답 검증

의존성 설치와 실행은 저장소 루트에서 진행합니다. 각 앱은 별도의 `package.json`을 갖고,
workspace와 lockfile은 저장소 루트의 것을 사용합니다.

```bash
pnpm install --frozen-lockfile
pnpm dev:web
# 별도 터미널에서 실행
pnpm dev:mobile
```

폴더를 묶어도 웹·앱의 React 버전, UI, 환경변수, 빌드·배포 과정은 합치지 않습니다.
Vercel의 Root Directory는 `frontend/web`이며 모바일은 별도로 빌드합니다.
자세한 경계와 검증 명령은 [웹·앱 공동 관리](../docs/mobile-monorepo.md)를 참고하세요.
