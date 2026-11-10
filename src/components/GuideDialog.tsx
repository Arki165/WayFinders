// Руководство пользователя. Открывается из меню в правом углу верхней панели.
// Сам текст руководства пока не написан: здесь будет оглавление по разделам программы.
import { tr } from "../i18n";
import Icon from "./Icon";

export default function GuideDialog({ onClose }: { onClose: () => void }) {
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog guide">
        <div className="guide-head">
          <h2>{tr("Руководство пользователя")}</h2>
          <button className="icon-btn" onClick={onClose} title={tr("Закрыть")}><Icon name="close" size={16} /></button>
        </div>
        <p className="hint">{tr("Руководство пока готовится. Подсказки по инструментам видны над картой, список горячих клавиш открывается клавишей «?».")}</p>
      </div>
    </div>
  );
}
