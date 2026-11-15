import { Children, cloneElement, useId, type ReactElement, type ReactNode } from "react";
import { InfoHelp } from "./info-help";
import { settingHelp } from "../../setting-help";

export function Field({ title, children, help = settingHelp(title) }: { title: string; children: ReactNode; help?: string | null }) {
  const generated = useId();
  const child = Children.only(children) as ReactElement<{ id?: string }>;
  const id = child.props.id ?? generated;
  return <div className="field">
    <div className="field-heading"><label htmlFor={id}>{title}</label>{help && <InfoHelp title={title}>{help}</InfoHelp>}</div>
    {cloneElement(child, { id })}
  </div>;
}
export function SettingHeading({ title, level = 3, help = settingHelp(title) }: { title: string; level?: 2 | 3 | 4; help?: string }) {
  const Heading = level === 2 ? "h2" : level === 4 ? "h4" : "h3";
  return <Heading className="setting-heading" aria-label={title}>{title}{help && <InfoHelp title={title}>{help}</InfoHelp>}</Heading>;
}
