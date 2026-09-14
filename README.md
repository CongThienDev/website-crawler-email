# Website Email Crawler (Node.js/TypeScript)

Tool độc lập để đọc cột `Website` trong sheet `Data unique`, tìm email công khai trên website và xuất kết quả XLSX/CSV. Folder này không import hoặc thay đổi code của scraper Google Maps ở thư mục cha.

## Cách hoạt động

1. Đọc một hoặc nhiều file XLSX và tự tìm dòng header có cột `Website`.
2. Chuẩn hóa URL, bỏ tracking parameters và dedupe URL giữa các file.
3. Dùng HTTP để đọc homepage và các trang liên hệ ưu tiên như `contact`, `about`, `team`, `impressum`.
4. Nếu HTTP không thấy email, dùng Playwright render JavaScript rồi thử lại.
5. Ghi từng website vào `checkpoint-results.jsonl`; chạy lại cùng `--output` sẽ tiếp tục phần chưa xong.
6. Ghi log chi tiết từng website vào `crawl.log`, log máy đọc được vào `events.ndjson` và in đồng thời ra terminal.
7. Xuất toàn bộ dòng nguồn kèm email, source URL, phương pháp tìm, score/confidence, trạng thái và số liệu benchmark.

Tool mặc định tôn trọng `robots.txt`, loại URL tracking/map/social profile phổ biến, giới hạn request trên cùng hostname và không nhận localhost/private IPv4 làm đầu vào.

## Cài đặt

Yêu cầu Node.js 20 trở lên.

```bash
cd website-email-crawler-node
npm install
npx playwright install chromium
```

Nếu chỉ benchmark HTTP thì không cần cài Chromium và thêm `--no-browser-fallback` khi chạy.

## UI chạy trên máy/VPS

UI vận hành nằm trong folder riêng này, không dùng chung UI của scraper Google Maps. UI nhận tối đa 4 file `.xlsx` có sheet `Data unique`, stream log theo từng website qua SSE, hiển thị progress/KPI/status/HTTP status và cho tải CSV/XLSX từ checkpoint ngay cả khi job còn chạy.

```bash
cd /path/to/GG_Map_Scraper_Email_PhoneNumber/website-email-crawler-node
npm install
npx playwright install chromium
UI_USERNAME=admin \
UI_PASSWORD='your-strong-password' \
HOST=0.0.0.0 PORT=8090 npm run ui
```

Mở `http://SERVER_IP:8090` rồi đăng nhập bằng `UI_USERNAME` và `UI_PASSWORD`. Mật khẩu phải có ít nhất 8 ký tự; server sẽ không khởi động nếu thiếu thông tin đăng nhập. Session mặc định tồn tại 12 giờ và được lưu trong memory, vì vậy restart server sẽ đăng xuất tất cả phiên.

Trên VPS nên chạy sau reverse proxy HTTPS. Khi public qua HTTPS, thêm `UI_COOKIE_SECURE=true`; nếu reverse proxy chuyển tiếp IP client đáng tin cậy thì thêm `TRUST_PROXY=true`. Có thể đổi thời gian session bằng `UI_SESSION_HOURS`. Xem [`.env.example`](.env.example) để biết đủ biến cấu hình. Không commit file `.env` thật vào Git.

Toàn bộ API job, SSE realtime và file tải xuống đều yêu cầu session hợp lệ. Đăng nhập sai 5 lần từ cùng một IP sẽ bị khóa 15 phút. `ui-runs/` chứa file upload, checkpoint và kết quả của từng job nên đã được thêm vào `.gitignore`.

Nút tải trong lúc đang chạy xuất phần dữ liệu đã checkpoint đến thời điểm bấm; tải lại sau khi hoàn tất để nhận đủ kết quả. Danh sách job hiện được giữ trong memory của tiến trình UI, vì vậy sau khi restart server cần mở lại file kết quả trong `ui-runs/` (checkpoint vẫn còn trên đĩa).

## Benchmark nhanh trên 500 website

Hai tool cần chạy cùng 500 website đầu tiên, cùng timeout và cùng chính sách robots để số liệu có thể so sánh.

```bash
npm run crawl -- \
  --input "/path/to/leads-part-1.xlsx" \
  --input "/path/to/leads-part-2.xlsx" \
  --sheet "Data unique" \
  --output "runs/benchmark-500" \
  --limit 500 \
  --concurrency 25 \
  --max-pages 5
```

Chạy HTTP-only để đo baseline tốc độ:

```bash
npm run crawl -- \
  --input "/path/to/file.xlsx" \
  --output "runs/http-only-500" \
  --limit 500 \
  --no-browser-fallback
```

Chạy toàn bộ hai file:

```bash
npm run crawl -- \
  --input "/path/to/leads-part-1.xlsx" \
  --input "/path/to/leads-part-2.xlsx" \
  --output "runs/full-vps"
```

Giữ nguyên `--output` khi chạy lại để resume. Không dùng chung một output folder cho hai cấu hình benchmark khác nhau vì checkpoint cũ sẽ được tái sử dụng.

## Tuỳ chọn quan trọng

| Option | Mặc định | Ý nghĩa |
| --- | ---: | --- |
| `--limit` | `0` | `0` là toàn bộ; số khác lấy N website duy nhất đầu tiên |
| `--concurrency` | `25` | Số website chạy HTTP đồng thời |
| `--max-pages` | `5` | Số trang tối đa trên mỗi website |
| `--contact-pages` | `1` | Số trang contact/about điểm cao nhất khi homepage chưa có email |
| `--timeout-ms` | `15000` | Timeout cho một HTTP request |
| `--robots-timeout-ms` | `5000` | Timeout riêng cho robots.txt |
| `--browser-concurrency` | `4` | Số page Playwright đồng thời, tự giảm khi có 403/429 |
| `--no-browser-fallback` | tắt | Chỉ chạy HTTP |
| `--collect-all` | tắt | Vẫn quét tiếp sau khi đã thấy email đầu tiên |
| `--no-respect-robots` | tắt | Bỏ kiểm tra robots.txt; chỉ dùng khi bạn có quyền crawl |
| `--domain-delay-ms` | `300` | Delay tối thiểu trên cùng hostname |

`--log-every` vẫn được chấp nhận để không làm hỏng lệnh cũ, nhưng không còn điều khiển log. Log từng URL luôn được bật.

## File kết quả

- `checkpoint-results.jsonl`: checkpoint append-only để resume.
- `email-results-<timestamp>.xlsx`: dữ liệu nguồn và cột email.
- `email-results-<timestamp>.csv`: cùng dữ liệu, thuận tiện import database.
- `benchmark-summary-<timestamp>.json`: hit rate, tốc độ, request count và số browser page.
- `events.ndjson`: từng event `start`, `done`, `metrics`, `throttle` để phân tích bằng `jq`, Python hoặc Grafana/Loki.

Các trạng thái chính: `found_http`, `found_browser`, `no_email`, `http_error`, `browser_error`, `robots_denied`, `no_website`, `invalid_url`.

## Log realtime theo từng website

Tool không còn chỉ in tiến độ mỗi 50 website. Mỗi URL có hai dòng `START`/`DONE` trong terminal và `crawl.log`:

```text
[INFO] START PHASE=HTTP URL=STATTNER.COM DONE=3/500 ACTIVE=25
[INFO] DONE URL=STATTNER.COM EMAIL=contact@stattner.com SOURCE=mailto SCORE=70 STATUS=FOUND_HTTP PHASE=HTTP PROGRESS=4/500 ACTIVE=24 DURATION_MS=123 PAGES=1 HTTP_REQUESTS=1 BROWSER_PAGES=0 HTTP_STATUS=200
```

Nếu không tìm thấy email, dòng kết quả là `NOT FOUND EMAIL`. `FALLBACK_REASON` chỉ xuất hiện khi URL thực sự đủ điều kiện chuyển sang browser. Nếu website trả 403/429, dòng đó ghi `ERROR_CLASS` và status tương ứng nhưng không fallback. Cứ mỗi 10 giây tool ghi thêm `METRICS` gồm tốc độ, active và phân bố trạng thái. Khi fallback browser cập nhật lại kết quả của một URL, progress không bị cộng lần hai.

File `crawl.log` được append đồng bộ nên vẫn xem được các website đã xử lý nếu bạn dừng bằng `Ctrl+C`. Checkpoint vẫn được ghi từng kết quả vào `checkpoint-results.jsonl`.

## Kiểm tra code

```bash
npm test
npm run check
npm run build
```

Chỉ thu thập địa chỉ liên hệ được công khai trên website. Hãy tuân thủ điều khoản website, quy định bảo vệ dữ liệu và quy định chống spam áp dụng cho mục đích sử dụng của bạn.








brew install node@20
echo 'export PATH="/opt/homebrew/opt/node@20/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
