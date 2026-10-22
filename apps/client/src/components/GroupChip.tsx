interface GroupChipProps {
  groupId: string | null;
  groupName?: string | null;
  groupAvatar?: string | null;
}

/** 群来源 chip：优先展示群名称，群号只作为附注，避免只看到一串数字。 */
export function GroupChip({ groupId, groupName, groupAvatar }: GroupChipProps) {
  const manual = !groupId;
  const name = groupName?.trim() ?? "";
  const label = manual ? "手动创建" : name || `群 ${groupId}`;
  const title = manual
    ? "手动创建"
    : name
      ? `来源群：${name}（${groupId}）`
      : `来源群：${groupId}`;

  return (
    <span className={`chip${manual ? " chip--manual" : ""}`} title={title}>
      {groupId && groupAvatar ? (
        <img className="chip__avatar" src={groupAvatar} alt="" loading="lazy" />
      ) : (
        <span className="chip__dot" aria-hidden="true" />
      )}
      <span className="chip__text">{label}</span>
      {!manual && name ? <span className="chip__sub">#{groupId}</span> : null}
    </span>
  );
}
