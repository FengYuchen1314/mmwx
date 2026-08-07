package bot

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/go-telegram/bot"
	"github.com/go-telegram/bot/models"
)

func (s *Service) handleServerRenewedCallback(ctx context.Context, b *bot.Bot, update *models.Update) {
	cq := update.CallbackQuery
	if cq == nil || cq.From.ID == 0 {
		return
	}
	if !s.isAdminTG(ctx, cq.From.ID) {
		_, _ = b.AnswerCallbackQuery(ctx, &bot.AnswerCallbackQueryParams{CallbackQueryID: cq.ID, Text: "仅管理员可操作", ShowAlert: true})
		return
	}
	parts := strings.Split(cq.Data, ":")
	if len(parts) != 3 || len(parts[2]) != 8 {
		_, _ = b.AnswerCallbackQuery(ctx, &bot.AnswerCallbackQueryParams{CallbackQueryID: cq.ID, Text: "无效的续费按钮", ShowAlert: true})
		return
	}
	serverID, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil || serverID <= 0 {
		_, _ = b.AnswerCallbackQuery(ctx, &bot.AnswerCallbackQueryParams{CallbackQueryID: cq.ID, Text: "无效的续费按钮", ShowAlert: true})
		return
	}
	result, err := s.client.ConfirmServerRenewed(ctx, serverID, parts[2])
	if err != nil {
		_, _ = b.AnswerCallbackQuery(ctx, &bot.AnswerCallbackQueryParams{CallbackQueryID: cq.ID, Text: "续期失败：" + err.Error(), ShowAlert: true})
		return
	}
	if !result.Processed {
		_, _ = b.AnswerCallbackQuery(ctx, &bot.AnswerCallbackQueryParams{CallbackQueryID: cq.ID, Text: "该通知已处理或到期日已变更", ShowAlert: true})
		return
	}
	expires := result.ExpiresAt
	if parsed, parseErr := time.Parse(time.RFC3339, expires); parseErr == nil {
		expires = parsed.Format("2006-01-02")
	}
	text := fmt.Sprintf("✅ 已记录服务器续费\n\n服务器：%s\n新到期日：%s", result.ServerName, expires)
	if cq.Message.Message != nil {
		_, _ = b.EditMessageText(ctx, &bot.EditMessageTextParams{ChatID: cq.Message.Message.Chat.ID, MessageID: cq.Message.Message.ID, Text: text})
	}
	_, _ = b.AnswerCallbackQuery(ctx, &bot.AnswerCallbackQueryParams{CallbackQueryID: cq.ID, Text: "服务器时长已增加"})
}
