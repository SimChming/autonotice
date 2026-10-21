# Build stage (static, CGO disabled because modernc.org/sqlite is pure Go).
FROM golang:1.22-alpine AS build
# Deployment target is a China-hosted Aliyun box; a mirror avoids the blocked
# proxy.golang.org. Both variables are harmless outside China (falls back to direct).
ENV GOPROXY=https://goproxy.cn,direct
ENV GOSUMDB=sum.golang.google.cn
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /out/qqsched ./cmd/app

# Runtime stage.
FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata
# Optional helpers that improve legacy document parsing (fall back to pure Go).
RUN apk add --no-cache poppler-utils || true
COPY --from=build /out/qqsched /qqsched
VOLUME ["/data"]
EXPOSE 8080
ENTRYPOINT ["/qqsched"]
CMD ["-config", "/config/config.yaml"]
