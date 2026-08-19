# Hai Ha USD Watch v2.2 — Live calculator quote

Ứng dụng PWA theo dõi đúng giao dịch:

**YOU SELL USD → YOU RECEIVE AUD tại Hai Ha**

## Cách v2.2 lấy tỷ giá

Backend không dùng Google/XE/Wise và không dựa vào việc đảo headline `1 AUD = X USD`.

Nó mở calculator công khai của Hai Ha, xác minh tab **YOU SELL**, xác minh ô bán là **USD** và ô nhận là **AUD**, nhập một quote thử **1,500 USD**, đọc số **AUD** calculator trả về, rồi tính:

`USD→AUD rate = AUD received / USD sold`

Ví dụ nếu Hai Ha hiển thị bán `1,500 USD` và nhận `2,051.70 AUD`, app tính `1 USD = 1.3678 AUD`.

Nếu không xác minh được đúng SELL + USD → AUD, hoặc Hai Ha maintenance, API trả lỗi và app giữ tỷ giá cuối/manual fallback. Không đoán tỷ giá.

## Tần suất cập nhật

- Khi app mở: kiểm tra ngay nếu dữ liệu đã đến hạn.
- Sau đó: kiểm tra Hai Ha tối đa **mỗi 5 phút** khi app đang ở foreground.
- Khi quay lại app: kiểm tra lại nếu quá 5 phút kể từ lần check cuối.
- Nút **Cập nhật từ Hai Ha** cho phép kiểm tra ngay.

> Đây chưa phải theo dõi 24/7 khi app đã đóng. Muốn cảnh báo khi app đóng cần thêm backend scheduler + database + Web Push ở phase tiếp theo.

## Chạy test

```bash
npm install
npm test
npm run check
```

## Deploy Vercel

1. Upload project lên GitHub hoặc import project vào Vercel.
2. Vercel dùng Node `24.x` theo `package.json`.
3. `api/haiha-rate.js` là Serverless Function và có `maxDuration: 30` trong `vercel.json`.
4. Deploy.
5. Mở `/api/haiha-rate` để xem JSON debug/status.
6. Mở trang chính và bấm **Cập nhật từ Hai Ha**.

## Lưu ý

Calculator Hai Ha là giao diện bên ngoài có thể thay đổi DOM. Nếu Hai Ha đổi giao diện, backend có thể trả lỗi cho tới khi selector/verification được cập nhật. Đây là chủ ý an toàn: thà không có rate còn hơn đọc nhầm BUY/SELL.
