FROM alpine:3.22

RUN apk add --no-cache ffmpeg

ENV PORT=8080

CMD ["/bin/sh", "-lc", "exec ffmpeg -hide_banner -loglevel warning -re -f lavfi -i testsrc2=size=1280x720:rate=25 -f lavfi -i sine=frequency=1000:sample_rate=48000 -c:v libx264 -preset veryfast -tune zerolatency -pix_fmt yuv420p -g 50 -keyint_min 50 -sc_threshold 0 -b:v 1800k -maxrate 1800k -bufsize 3600k -c:a aac -b:a 128k -ar 48000 -ac 2 -f mpegts -mpegts_flags +resend_headers -listen 1 http://0.0.0.0:${PORT}/live.ts"]
