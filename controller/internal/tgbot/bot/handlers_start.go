package bot

import (
	"context"
	"fmt"
	"strings"

	"github.com/go-telegram/bot"
	"github.com/go-telegram/bot/models"

	"miaomiaowux/internal/tgbot/mmwxclient"
)

// handleStart /start 入口。
//
//	A) 无 code:已绑 → 主菜单;未绑 → 提示要邀请码
//	B) /start <code>:校验 kind = bind → 调主控 /bind kind=bind
//	   /start <code>:校验 kind = new  → 开启多步注册对话(收集 username/email)
//
// 群里 /start 直接拒(防邀请码泄露)。
func (s *Service) handleStart(ctx context.Context, b *bot.Bot, update *models.Update) {
	if update.Message == nil || update.Message.From == nil {
		return
	}
	chatID := update.Message.Chat.ID
	tgID := update.Message.From.ID
	tgHandle := update.Message.From.Username

	if update.Message.Chat.Type != "private" {
		_, _ = b.SendMessage(ctx, &bot.SendMessageParams{
			ChatID: chatID,
			Text:   "请在私聊里使用本机器人。",
		})
		return
	}

	args := strings.TrimSpace(strings.TrimPrefix(update.Message.Text, "/start"))
	args = strings.TrimSpace(args)

	// A 无 code
	if args == "" {
		info, err := s.client.UserByTG(ctx, tgID)
		if err == nil && info.Bound {
			_, _ = b.SendMessage(ctx, &bot.SendMessageParams{
				ChatID: chatID,
				Text: fmt.Sprintf("已绑定账号:%s\n\n常用:/me /sub /traffic /nodes /unbind /help",
					info.Username),
			})
			return
		}
		_, _ = b.SendMessage(ctx, &bot.SendMessageParams{
			ChatID: chatID,
			Text: "欢迎使用妙妙屋X。\n" +
				"本系统仅接受邀请码注册/绑定。请联系管理员要邀请码后用 /start <code>。",
		})
		return
	}

	// B/C 有 code
	code := strings.ToUpper(strings.Fields(args)[0])

	// 先用 list 端点找出该 code(没有单查端点,bot 拉一批本地过滤;也可走 /bind 让主控判)
	// 简化:直接调 /bind,主控校验邀请码合法性 + dispatch kind。
	// 但 kind=new 要 username/email 多步对话,所以这里要先知道 kind。
	// 方案:用 ListInvites 拉所有(admin 视角能看全),本地查 code。
	invites, err := s.client.ListInvites(ctx, 200)
	if err != nil {
		_, _ = b.SendMessage(ctx, &bot.SendMessageParams{ChatID: chatID, Text: "查询邀请码失败:" + err.Error()})
		return
	}
	var ic *mmwxclient.Invite
	for i := range invites {
		if invites[i].Code == code {
			ic = &invites[i]
			break
		}
	}
	if ic == nil {
		_, _ = b.SendMessage(ctx, &bot.SendMessageParams{ChatID: chatID, Text: "邀请码不存在。"})
		return
	}
	if !ic.Usable {
		reason := "邀请码已不可用"
		if ic.Revoked {
			reason = "邀请码已被撤销"
		} else if ic.UsedCount >= ic.MaxUses {
			reason = "邀请码已用尽"
		}
		_, _ = b.SendMessage(ctx, &bot.SendMessageParams{ChatID: chatID, Text: reason})
		return
	}

	// 已绑 → 拒
	if info, err := s.client.UserByTG(ctx, tgID); err == nil && info.Bound {
		_, _ = b.SendMessage(ctx, &bot.SendMessageParams{
			ChatID: chatID,
			Text:   fmt.Sprintf("当前 TG 已绑定到 %s,请先 /unbind 解绑。", info.Username),
		})
		return
	}

	switch ic.Kind {
	case "bind":
		s.doBind(ctx, b, chatID, tgID, tgHandle, code)
	case "new":
		s.startRegistration(ctx, b, chatID, tgID, ic)
	}
}

// doBind 直接调主控 /bind(kind=bind 时无需多步对话)。
func (s *Service) doBind(ctx context.Context, b *bot.Bot, chatID, tgID int64, tgHandle, code string) {
	resp, err := s.client.Bind(ctx, mmwxclient.BindRequest{
		Code:           code,
		TelegramID:     tgID,
		TelegramHandle: tgHandle,
	})
	if err != nil {
		_, _ = b.SendMessage(ctx, &bot.SendMessageParams{ChatID: chatID, Text: "绑定失败:" + err.Error()})
		return
	}
	_, _ = b.SendMessage(ctx, &bot.SendMessageParams{
		ChatID: chatID,
		Text: fmt.Sprintf("绑定成功:%s\n\n/me /sub /traffic /nodes /unbind /help",
			resp.Username),
	})
}
