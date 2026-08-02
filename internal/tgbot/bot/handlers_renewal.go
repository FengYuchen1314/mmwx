package bot

import (
	"context"
	"fmt"
	"html"
	"strings"
	"time"

	"github.com/go-telegram/bot"
	"github.com/go-telegram/bot/models"

	"miaomiaowux/internal/tgbot/mmwxclient"
)

type RenewalNotice struct {
	Token           string
	Username        string
	TelegramID      int64
	PackageName     string
	PreviousEndDate string
	RenewDays       int
	Source          string
	Passphrase      string
}

func (s *Service) NotifyRenewalRequest(ctx context.Context, n RenewalNotice) error {
	s.mu.Lock()
	b := s.b
	admins := append([]int64(nil), s.cfg.AdminTGIDs...)
	s.mu.Unlock()
	if b == nil || len(admins) == 0 {
		return fmt.Errorf("TGBot 未运行或未配置管理员")
	}
	previous := "无"
	if n.PreviousEndDate != "" {
		if parsed, err := time.Parse(time.RFC3339, n.PreviousEndDate); err == nil {
			previous = parsed.Format("2006-01-02")
		} else {
			previous = n.PreviousEndDate
		}
	}
	source := "主控"
	if n.Source == "tg-miniapp" {
		source = "TG Mini App"
	}
	text := fmt.Sprintf("📮 <b>收到续费申请</b>\n\n用户：<code>%s</code>\n套餐：%s\n原到期：%s\n续费周期：%d 天\n来源：%s\n\n口令：\n<code>%s</code>",
		html.EscapeString(n.Username), html.EscapeString(n.PackageName), html.EscapeString(previous), n.RenewDays, source, html.EscapeString(n.Passphrase))
	kb := &models.InlineKeyboardMarkup{InlineKeyboard: [][]models.InlineKeyboardButton{
		{{Text: "📋 复制口令", CopyText: &models.CopyTextButton{Text: n.Passphrase}}},
		{{Text: "✅ 确认续费", CallbackData: "rr:a:" + n.Token}, {Text: "❌ 拒绝", CallbackData: "rr:r:" + n.Token}},
	}}
	var firstErr error
	sent := 0
	for _, id := range admins {
		if _, err := b.SendMessage(ctx, &bot.SendMessageParams{ChatID: id, Text: text, ParseMode: models.ParseModeHTML, ReplyMarkup: kb}); err != nil {
			if firstErr == nil {
				firstErr = err
			}
		} else {
			sent++
		}
	}
	if sent == 0 {
		return firstErr
	}
	return nil
}

func (s *Service) handleRenewalCallback(ctx context.Context, b *bot.Bot, update *models.Update) {
	cq := update.CallbackQuery
	if cq == nil || cq.From.ID == 0 {
		return
	}
	if !s.cfg.IsAdmin(cq.From.ID) {
		_, _ = b.AnswerCallbackQuery(ctx, &bot.AnswerCallbackQueryParams{CallbackQueryID: cq.ID, Text: "仅管理员可操作", ShowAlert: true})
		return
	}
	parts := strings.Split(cq.Data, ":")
	if len(parts) != 3 || (parts[1] != "a" && parts[1] != "r") {
		_, _ = b.AnswerCallbackQuery(ctx, &bot.AnswerCallbackQueryParams{CallbackQueryID: cq.ID, Text: "无效请求", ShowAlert: true})
		return
	}
	approve := parts[1] == "a"
	req, processed, err := s.client.ReviewRenewalRequest(ctx, parts[2], cq.From.ID, approve)
	if err != nil {
		_, _ = b.AnswerCallbackQuery(ctx, &bot.AnswerCallbackQueryParams{CallbackQueryID: cq.ID, Text: "处理失败：" + err.Error(), ShowAlert: true})
		return
	}
	statusText := "❌ 续费申请已拒绝"
	userText := "❌ 您的续费申请未通过\n\n套餐：" + req.PackageName
	if req.Status == "approved" {
		end := formatRenewalDate(req.NewEndDate)
		statusText = fmt.Sprintf("✅ 续费成功\n\n用户：%s\n套餐：%s\n新到期：%s\n审批人：%d", req.Username, req.PackageName, end, cq.From.ID)
		userText = fmt.Sprintf("✅ 您的套餐已续费成功\n\n套餐：%s\n续费周期：%d 天\n新到期：%s", req.PackageName, req.RenewDays, end)
	} else if req.Status != "rejected" {
		statusText = "ℹ️ 该申请已被其他管理员处理，当前状态：" + req.Status
	}
	if cq.Message.Message != nil {
		_, _ = b.EditMessageText(ctx, &bot.EditMessageTextParams{ChatID: cq.Message.Message.Chat.ID, MessageID: cq.Message.Message.ID, Text: statusText})
	}
	if processed {
		for _, adminID := range s.cfg.AdminTGIDs {
			_, _ = b.SendMessage(ctx, &bot.SendMessageParams{ChatID: adminID, Text: statusText})
		}
	}
	if processed && req.TelegramID != 0 && (req.Status == "approved" || req.Status == "rejected") {
		_, _ = b.SendMessage(ctx, &bot.SendMessageParams{ChatID: req.TelegramID, Text: userText})
	}
	answerText := "申请已处理"
	if processed && req.Status == "approved" {
		answerText = "续费成功"
	} else if processed && req.Status == "rejected" {
		answerText = "已拒绝续费"
	}
	_, _ = b.AnswerCallbackQuery(ctx, &bot.AnswerCallbackQueryParams{CallbackQueryID: cq.ID, Text: answerText, ShowAlert: false})
}

func formatRenewalDate(value string) string {
	if t, err := time.Parse(time.RFC3339, value); err == nil {
		return t.Format("2006-01-02")
	}
	if len(value) >= 10 {
		return value[:10]
	}
	return value
}

func renewalNoticeFromClient(req *mmwxclient.RenewalRequest, passphrase string) RenewalNotice {
	return RenewalNotice{Token: req.RequestToken, Username: req.Username, TelegramID: req.TelegramID, PackageName: req.PackageName,
		PreviousEndDate: req.PreviousEndDate, RenewDays: req.RenewDays, Source: req.Source, Passphrase: passphrase}
}
