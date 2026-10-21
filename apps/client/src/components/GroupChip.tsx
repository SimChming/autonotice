interface GroupChipProps {
  groupId: string | null;
}

/** 群来源 chip：服务端没有群名，先展示群号，避免凭空编造。 */
export function GroupChip({ groupId }: GroupChipProps) {
  const manual = !groupId;
  return (
    <span
      className={`chip${manual ? " chip--manual" : ""}`}
      title={groupId ? `来源群：${groupId}` : "手动创建"}
    >
      <span className="chip__dot" aria-hidden="true" />
      <span className="chip__text">{groupId ? `群 ${groupId}` : "手动创建"}</span>
    </span>
  );
}
