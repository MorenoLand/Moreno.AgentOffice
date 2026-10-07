package office

type Browser interface {
	OpenURL(url string) error
	OpenFile(path string) error
}

type webBrowser struct {
	hub *Hub
}

func (b *webBrowser) OpenURL(url string) error {
	b.hub.Send("open-url", map[string]any{"url": url})
	return nil
}

func (b *webBrowser) OpenFile(path string) error {
	b.hub.Send("open-path", map[string]any{"path": path})
	return nil
}
