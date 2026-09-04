package main

import "testing"

func TestIsShortCodeSegment(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		code string
		want bool
	}{
		{name: "letters and digits", code: "AbC123", want: true},
		{name: "underscore", code: "file_user", want: true},
		{name: "hyphen", code: "file-user", want: true},
		{name: "slash", code: "file/user", want: false},
		{name: "dot", code: "file.user", want: false},
		{name: "space", code: "file user", want: false},
		{name: "non ascii", code: "短码", want: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got := isShortCodeSegment(tt.code); got != tt.want {
				t.Fatalf("isShortCodeSegment(%q) = %v, want %v", tt.code, got, tt.want)
			}
		})
	}
}
