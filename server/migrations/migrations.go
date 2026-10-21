// Package migrations embeds the SQL migration files applied by internal/store.
package migrations

import "embed"

// FS holds the ordered *.sql migration files. Files are applied in lexical
// filename order.
//
//go:embed *.sql
var FS embed.FS
