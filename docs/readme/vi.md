# DishyWarden

**Công cụ giám sát mã nguồn mở cho đầu cuối Starlink** ——
ứng dụng máy tính kết nối với API gRPC cục bộ của đầu cuối, biến các con số thô
thành thông tin dùng được, và báo ngay khi có gì bất ổn.

> Dữ liệu của bạn nằm lại trên máy của bạn. Kênh đám mây tùy chọn chỉ mang
> số phiên bản ẩn danh và báo cáo sai sót **khi bạn đồng ý rõ ràng**
> (xem [Quyền riêng tư](#-quyền-riêng-tư)).

---

## 📸 Ảnh chụp màn hình

| Bảng điều khiển | Bản đồ che chắn |
|---|---|
| ![Bảng điều khiển](docs/screenshots/dashboard.png) | ![Bản đồ che chắn](docs/screenshots/obstruction.png) |

> Ảnh chụp từ phiên chạy thật, không phải bản dựng minh họa.

---

## ✨ Những gì bạn có

**Giám sát trực tiếp**

- Mức tín hiệu, độ trễ, mất gói, thông lượng và tỉ lệ online ——
  lấy mẫu mỗi 30 giây và lưu vào SQLite cục bộ
- Ra đơ phương vệ tinh: TLE thật + truyền dẫn SGP4, biểu đồ cực,
  và ước lượng hướng chùm tia về vệ tinh phục vụ
- Bản đồ che chắn bầu trời: phân cảnh bán cầu bằng WebGL, kèm tỉ lệ che chắn,
  mức độ nghiêm trọng, hướng che chắn chính và xu hướng thay đổi
- Màn hình chỉnh hướng: góc phương vị và góc cao để chỉnh tay đĩa

**Cảnh báo đáng tin**

- **27 quy tắc tích hợp** — ăn-tenh mất kết nối, độ trễ PoP, mất gói nặng,
  che chắn tầm nhìn, giảm tần số do quá nhiệt, lệch hướng, lỗi động cơ,
  bất thường GNSS, đóng băng và sấy băng, PoE/nguồn, bộ định tuyến offline,
  mất kết nối liên tục, chất lượng WiFi, thời tiết xấu, tài khoản bất thường,
  chuyển vùng vệ tinh và nhiều hơn nữa
- Ba kênh gửi: **Telegram**, **Email**, **Webhook**
  (có biến mẫu và mẫu payload dùng lại được)
- Hàng đợi ngoại tuyến: cảnh báo phát sinh lúc mất mạng sẽ được gửi lại khi
  kết nối trở lại
- Chống lặp do probe: cảnh báo do một probe hỏng không bắn hai lần

**Hiểu rõ đường mạng**

- Truy vết đường đi kèm sơ đồ từng chặng (kết quả `tracert` của Windows được
  phân tích theo từng cột)
- Node probe có ba loại — **ICMP**, **DNS**, **TLS** — để tách lỗi nằm ở đầu cuối,
  bộ định tuyến hay đường truyền
- Chỉ số Prometheus kèm sẵn bảng điều khiển Grafana

**Định vị**

- Vị trí đầu cuối được xác định theo chuỗi dự phòng ba bước:
  GPS của đầu cuối → định vị trình duyệt → ước lượng thô theo IP

**Được thiết kế để bảo trì lâu dài**

- Giao diện 5 ngôn ngữ: English, 简体中文, 日本語, 한국어, Tiếng Việt
- Cấu hình lưu ở JSON thuần; dữ liệu telemetry và cảnh báo nằm trong SQLite cục bộ

---

## 🚀 Bắt đầu nhanh

Cần **Node.js 20+** và một đầu cuối mà bạn kết nối được.

```bash
git clone %REPO_URL%.git
cd %REPO%
npm install
npm run dev
```

`npm run dev` chạy song song Vite dev server và Electron. Cửa sổ tải renderer ở
`http://localhost:5173`; **hãy kiểm tra tính năng trong cửa sổ Electron** —
bản chạy trên trình duyệt chỉ có dữ liệu giả lập.

### Kết nối với đầu cuối

DishyWarden nói chuyện với **API gRPC cục bộ** của đầu cuối:

| Cổng | Kiểu truyền | Vai trò |
|---|---|---|
| `9200` | gRPC gốc | đường chính |
| `9201` | grpc-web | dự phòng — một số firmware trả về `UNIMPLEMENTED` ở 9200 |

Đầu cuối không công bố API này ra mạng nội bộ, nên thường bạn cần chạy một
**cầu nối cục bộ** trên cùng máy để chuyển tiếp tới đầu cuối (ví dụ công cụ kiểu
`dishylink`), rồi điền địa chỉ và cổng trong **Cài đặt → Kết nối đầu cuối**.

---

## 🏗️ Build từ mã nguồn

```bash
npm ci
npm run build          # renderer + tiến trình chính + electron-builder
npm run build:win      # chỉ tạo trình cài đặt NSIS cho Windows
```

| Sản phẩm | Ghi chú |
|---|---|
| `release/` | thư mục đầu ra đóng gói (target của electron-builder) |
| `release/DishyWarden-Setup-<version>.exe` | trình cài đặt Windows, per-machine (cần quyền quản trị), cài đặt có hướng dẫn |

Nên chạy các kiểm tra sau trước khi commit:

```bash
npx tsc --noEmit -p tsconfig.json
npx tsc --noEmit -p tsconfig.electron.json
npm test               # vitest
npm run lint
```

---

## 📥 Cài bản phát hành

Tải bản mới nhất từ [trang phát hành](%REPO_URL%/releases):

| Nền tảng | Tệp |
|---|---|
| Windows x64 / arm64 | `DishyWarden-Setup-<version>.exe` (NSIS, per-machine) |
| macOS arm64 / x64 | `DishyWarden-<version>-<os>-<arch>.dmg` |

> **Bản build chưa được ký mã.** Windows sẽ hiện cảnh báo SmartScreen
> (“Windows đã bảo vệ PC của bạn”) — bấm *Thêm thông tin → Vẫn chạy*.
> macOS sẽ cách ly ứng dụng — nhấp chuột phải vào `.dmg` rồi chọn *Mở*, hoặc chạy
> `xattr -dr com.apple.quarantine /Applications/DishyWarden.app`.
> Mỗi bản đều kèm giá trị `sha512` để bạn tự đối chiếu.

Bản cập nhật do [electron-updater](https://github.com/electron-userland/electron-builder)
phát qua manifest `%FEED_URL%`; ứng dụng kiểm tra lúc khởi động và sau đó khoảng
mỗi 12 giờ, và im lặng bỏ qua nếu mạng không sẵn dụng.

---

## 📋 Yêu cầu hệ thống

| | |
|---|---|
| Hệ điều hành | Windows 10+, macOS 11+, Linux (X11) |
| Node.js | 20+ (chỉ khi phát triển) |
| Nền tảng chạy | Electron 33 · React 18 · TypeScript · Vite · Tailwind CSS 4 |
| Dung lượng | telemetry khoảng 1 MB/ngày (lấy mẫu mỗi 30 giây) |

---

## 🔐 Quyền riêng tư

**Trừ khi bạn cho phép rõ ràng, telemetry của bạn không rời khỏi máy này.**

| Dữ liệu | Đi đâu | Khi nào |
|---|---|---|
| Telemetry, cảnh báo, cấu hình | SQLite / JSON cục bộ | luôn luôn, chỉ trên máy bạn |
| Kiểm tra cập nhật (`upgrade_check` / `upgrade_heartbeat`) | `cloud.dishywarden.com` | tự động — chỉ kèm `client_id` ẩn danh, phiên bản, nền tảng và IP của bạn |
| Báo cáo sai sót | `cloud.dishywarden.com` | **chỉ khi bạn đồng ý** — kèm loại cảnh báo, mức độ, tiêu đề, ghi chú của bạn và (nếu bạn giữ) toạ độ |

- `client_id` là UUID ngẫu nhiên sinh ra trên máy bạn, không bắt nguồn từ phần cứng,
  tài khoản hay định danh mạng.
- Gửi báo cáo sai sót **mặc định tắt**, và bạn có thể tắt bất cứ lúc nào trong
  *Cài đặt → Cập nhật & phản hồi*. Lần gửi đầu tiên sẽ hiện rõ điều gì sẽ được
  gửi và cần bạn xác nhận.
- Máy chủ đám mây **không bao giờ** nhận tài khoản, thông tin xác thực thông báo
  (token Telegram, URL webhook, mật khẩu email), đường dẫn tệp hay tên máy chủ.
- Thời gian lưu trữ phía máy chủ: sự kiện cập nhật và phản hồi 90 ngày,
  nhật ký truy cập 14 ngày.

Chi tiết đầy đủ: **[PRIVACY.md](PRIVACY.md)**.

---

## 🧩 Kiến trúc

```
src/
├── main/        Tiến trình chính Electron — cửa sổ, IPC, client gRPC, updater
├── core/        Client gRPC tới đầu cuối, probe, traceroute, updater, client đám mây
├── storage/     Lưu trữ SQLite (telemetry + cảnh báo) và cấu hình
├── alerting/    Bộ máy luật, bộ phân phối thông báo, hàng đợi ngoại tuyến
├── collector/   Vòng lặp lấy mẫu 30 giây
├── prometheus/  Xuất chỉ số + bảng điều khiển Grafana
└── renderer/    Giao diện React (bảng điều khiển, cảnh báo, che chắn, vệ tinh, chỉnh hướng, cài đặt)
```

Vài quy tắc phân lớp đáng nhớ khi đóng góp:

- `src/storage/types.ts` **không được** import module native — renderer cũng
  import file này
- Sửa `src/main/**`, `src/core/**`, `src/storage/**` thì phải khởi động lại Electron;
  sửa phần renderer thì hot-reload
- Mọi chuỗi giao diện mới phải có đủ cả 5 ngôn ngữ, và bộ kiểm thử tập khóa i18n
  sẽ kiểm tra điều đó

---

## 📚 Tài liệu khác

| Tài liệu | Nội dung |
|---|---|
| [`docs/CLOUD-UPGRADE.md`](docs/CLOUD-UPGRADE.md) | Hợp đồng của manifest cập nhật và cách phát hành bản mới |

## 🛠️ Đóng góp

Chào mừng issue và pull request — xem [CONTRIBUTING.md](CONTRIBUTING.md) về môi
trường phát triển, quy ước commit và quy trình phát hành.

## 📄 Giấy phép

[MIT](LICENSE) © %YEAR% DishyWarden contributors
