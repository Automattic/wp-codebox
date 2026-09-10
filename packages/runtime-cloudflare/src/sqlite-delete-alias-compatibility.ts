/**
 * SQLite integration 2.2.23 translates a complete `tableAlias` node to
 * `AS alias`, then incorrectly uses that text as the DELETE target map key.
 * The driver's other alias maps correctly translate its identifier child.
 * Preserve the joined SELECT, value/version predicates and actual deletion.
 */
export function patchSqliteDeleteAlias(source: string): string {
  const before = "$alias = $this->unquote_sqlite_identifier( $this->translate( $alias_node ) );"
  const after = "$alias = $this->unquote_sqlite_identifier( $this->translate( $alias_node->get_first_child_node( 'identifier' ) ) );"
  if (!source.includes(before) && source.includes(after)) return source
  if (source.split(before).length !== 2) throw new Error("Unsupported SQLite multi-table DELETE alias implementation.")
  return source.replace(before, after)
}
