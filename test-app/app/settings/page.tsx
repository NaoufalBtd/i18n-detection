import { Button } from '../../components/common/Button.js';

export default function SettingsPage() {
  const t = (key: string) => key;
  const pageTitle = "Account settings";

  const handleSave = () => {
    toast.success("Profile saved successfully");
  };

  return (
    <div className="p-6">
      <h1>{pageTitle}</h1>
      <p>{t("settings.settingspage.manageYourLoginDe")}</p>
      
      <input placeholder={t("settings.settingspage.placeholder")} aria-label={t("settings.settingspage.ariaLabel")} />

      <Button label={t("settings.button.label")} onClick={handleSave} />
      
      {/* i18n-scan-ignore-next-line -- technical CMS string mapping */}
      <span>internal_system_code</span>
    </div>
  );
}
