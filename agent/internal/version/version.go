// Package version 维护 mmw-agent 的版本号。
// 主控通过 /api/child/system-info 拿到这个值与 GitHub Release tag 比对，触发升级提示。
package version

// Version is injected by the monorepo release workflow with -ldflags.
var Version = "dev"
