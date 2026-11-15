<!--
  本文件由 scripts/gen-readme.mjs 自动生成 —— 请勿直接编辑。
  源文件：docs/privacy/vi.md
  改完源文件后执行：node scripts/gen-readme.mjs
-->

<div align="center">

  ![License: MIT](https://img.shields.io/badge/license-MIT-green.svg) ![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg) ![Electron](https://img.shields.io/badge/electron-33-blue.svg) ![i18n](https://img.shields.io/badge/i18n-5%20languages-blueviolet.svg)

</div>

<div align="center">
  <a href="./README.md">English</a> · <a href="./README.zh-CN.md">简体中文</a> · <a href="./README.ja.md">日本語</a> · <a href="./README.ko.md">한국어</a> · <strong>Tiếng Việt</strong>
</div>

# Chính sách bảo mật

_Cập nhật lần cuối: 2026_

DishyWarden là công cụ giám sát dành cho đầu cuối Starlink. Ứng dụng được thiết kế
để **dữ liệu telemetry của bạn nằm lại trên máy của bạn**. Tài liệu này giải thích
hai trường hợp duy nhất có dữ liệu rời khỏi máy, và cách tắt từng trường hợp.

---

## 1. Những dữ liệu không bao giờ rời khỏi máy bạn

Dưới đây chỉ được lưu **cục bộ** và không bao giờ được truyền đi:

| Dữ liệu | Nơi lưu |
|---|---|
| Mẫu telemetry (tín hiệu, độ trễ, thông lượng, tỉ lệ online) | `telemetry.db` (SQLite) trong thư mục dữ liệu người dùng |
| Cảnh báo và vòng đời của chúng | `alerts.db` (SQLite) trong thư mục dữ liệu người dùng |
| Cài đặt, node probe, cấu hình thông báo | một tệp JSON thuần trong thư mục dữ liệu người dùng |
| Thông tin xác thực thông báo (token bot Telegram, URL webhook, mật khẩu email) | cùng tệp JSON cục bộ đó |

Máy chủ **không bao giờ** nhận tài khoản, thông tin xác thực thông báo, đường dẫn
tệp hay tên máy chủ của bạn.

## 2. Hai kênh đi ra ngoài

### 2.1 Kiểm tra cập nhật — tự động, tối thiểu

Để báo cho bạn biết có phiên bản mới, ứng dụng truy cập manifest cập nhật trên
`cloud.dishywarden.com` và báo kết quả.

**Gửi đi:** `client_id` ẩn danh (UUID v4 ngẫu nhiên sinh ra trên máy bạn),
phiên bản ứng dụng, nền tảng, và địa chỉ IP của yêu cầu.

**Không gửi:** bất kỳ mục nào trong mục 1.

**Thời gian lưu:** sự kiện cập nhật bị xóa sau 90 ngày. Nhật ký truy cập được luân
chuyển ở 14 ngày.

**Cách tắt:** để trống URL nguồn cập nhật trong *Cài đặt → Cập nhật & phản hồi*,
hoặc xoá điểm cuối đám mây trong cài đặt. Khi đó ứng dụng hoàn toàn không liên
lạc với đám mây.

### 2.2 Báo cáo sai sót — mặc định tắt, cần bạn đồng ý

Khi bạn đánh dấu một cảnh báo là báo động giả, ứng dụng có thể gửi một báo cáo
ẩn danh để tinh chỉnh bộ luật cảnh báo. **Tính năng này mặc định tắt.**

**Gửi đi:** loại cảnh báo, mức độ, tiêu đề, ghi chú tuỳ chọn của bạn, phiên bản
ứng dụng, nền tảng, `client_id` ẩn danh, địa chỉ IP, và — chỉ khi cài đặt của
bạn vẫn còn thông tin vị trí — toạ độ của bạn.

**Không gửi:** tài khoản, thông tin xác thực thông báo, đường dẫn tệp, tên máy
chủ, hay bất kỳ dữ liệu telemetry nào khác.

**Thời gian lưu:** phản hồi bị xóa sau 90 ngày.

**Cách tắt:** cứ để *Cài đặt → Cập nhật & phản hồi → Báo cáo mẫu báo động giả*
ở trạng thái tắt. Lần gửi đầu tiên sẽ hiển thị rõ những trường sẽ được gửi và
cần bạn xác nhận. Bạn cũng có thể xoá điểm cuối đám mây để dừng mọi yêu cầu đi ra.

## 3. Cách ẩn danh hoá

- `client_id` là UUID v4 ngẫu nhiên sinh cục bộ. Nó **không** được suy ra từ mã
  định danh phần cứng, tài khoản hay danh tính mạng, và máy chủ không thể dùng nó
  để liên kết trở lại với bạn.
- Danh sách trường được cưỡng chế **ở cả phía máy khách và phía máy chủ**.
  Trường không nằm trong danh sách sẽ bị loại bỏ, kể cả khi có người gửi lên.
- Điểm cuối đám mây có giới hạn tần suất theo địa chỉ IP.

## 4. Nơi dữ liệu được xử lý

Dịch vụ đám mây chạy trên một máy chủ duy nhất do người duy trì dự án vận hành,
đặt tại Nhật Bản. Dữ liệu nêu trên được lưu dưới dạng tệp JSON chỉ ghi nối,
chia theo ngày UTC.

## 5. Do Not Track / cookie

DishyWarden là một ứng dụng máy tính. Nó không đặt cookie, không chạy trình theo
dõi, không nhúng phân tích, và không dịch vụ bên thứ ba nào nhận dữ liệu của
bạn.

## 6. Quyền của bạn

Vì dữ liệu hoặc là ẩn danh, hoặc là do bạn tự nguyện gửi, và bị xóa theo lịch
ngắn, bạn có thể thực hiện quyền của mình chỉ bằng cách:

- tắt các kênh ở mục 2, và/hoặc
- xoá điểm cuối đám mây trong cài đặt, và/hoặc
- yêu cầu người duy trì xoá một `client_id` cụ thể khỏi các sự kiện đã lưu.

Để yêu cầu xoá dữ liệu, hãy mở một issue trong kho lưu trữ hoặc liên hệ trực
tiếp người duy trì.

## 7. Thay đổi chính sách

Mọi thay đổi quan trọng sẽ được thông báo trong ghi chú phát hành của phiên bản
đưa ra thay đổi đó, kèm việc cập nhật ngày "cập nhật lần cuối" ở trên.

## 8. Liên hệ

Câu hỏi về quyền riêng tư có thể gửi qua issue trong kho lưu trữ, hoặc gửi trực
tiếp cho người duy trì.

---

Xem thêm [README](README.md) để có tổng quan tính năng và hướng dẫn build.
