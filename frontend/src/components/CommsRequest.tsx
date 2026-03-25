import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Form } from 'react-bootstrap';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useContent } from '../contexts/ContentContext';
import { useNavigate } from 'react-router-dom';
import { ContentSubmission } from '../types/content';
import LexicalEditorComponent from './editor/LexicalEditor';
import { User } from '../types';
import { API_URL } from '../config';
import TemplatePicker from './TemplatePicker';
import AudienceCard from './AudienceCard';
import FormSummarySidebar from './FormSummarySidebar';
import DatePicker from 'react-datepicker';
import 'react-datepicker/dist/react-datepicker.css';
import './CommsRequest.css';

const commsRequestSchema = z.object({
  email: z.string().email('Please enter a valid email address'),
  owner: z.string().min(1, 'Owner is required'),
  publishBy: z.string().min(1, 'Publish date is required'),
  urgentRequest: z.boolean().optional(),
  audience: z.array(z.string()).min(1, 'Please select at least one audience'),
  otherAudienceText: z.string().optional(),
  description: z.string().min(1, 'Description is required'),
  suggestedSubjectLine: z.string().min(1, 'Subject line is required'),
  replyToAddress: z.string().email('Please enter a valid reply-to email address'),
  text: z.string().optional(),
  signatureText: z.string().min(1, 'Signature text is required'),
  notes: z.string().optional(),
});

type CommsRequestFormData = z.infer<typeof commsRequestSchema>;

const STEPS = [
  { label: 'Content', number: 1 },
  { label: 'Audience & Timing', number: 2 },
  { label: 'Approvers', number: 3 },
];

const AUDIENCE_LABELS: Record<string, string> = {
  newsletter: 'Include in Ranger Newsletter (sent over Ranger Announce)',
  singular: 'Singular announcement (outside of Ranger Newsletter)',
  allcom: 'Allcom',
  website_update: 'Website - new or changed content',
  jrs: 'JRS/Event Ops/Other BMP Audience',
  event: "Let's plan an event",
  other: 'Other',
};

const AUDIENCE_CARDS = [
  { id: 'newsletter', label: 'Newsletter', description: 'Included in the next Ranger newsletter — sent over Ranger Announce', icon: 'fas fa-newspaper' },
  { id: 'singular', label: 'Singular Announcement', description: 'A standalone announcement sent over Ranger Announce', icon: 'fas fa-bullhorn' },
  { id: 'allcom', label: 'Allcom', description: 'Broadcast to the full Allcom distribution list', icon: 'fas fa-broadcast-tower' },
  { id: 'website_update', label: 'Website Update', description: 'New or changed content for the Ranger website', icon: 'fas fa-globe' },
  { id: 'jrs', label: 'JRS / Event Ops', description: 'Communication targeted at JRS, Event Ops, or other BMP teams', icon: 'fas fa-users' },
  { id: 'event', label: 'Plan an Event', description: 'Coordination for an upcoming Ranger event', icon: 'fas fa-calendar-alt' },
  { id: 'other', label: 'Other', description: 'Something else — describe below', icon: 'fas fa-ellipsis-h' },
];

export const CommsRequest: React.FC = () => {
  const [step, setStep] = useState(1);
  const [showSuccess, setShowSuccess] = useState(false);
  const [editorContent, setEditorContent] = useState('');
  const [stepErrors, setStepErrors] = useState<string[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const { saveSubmission } = useContent();
  const navigate = useNavigate();
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const userJson = localStorage.getItem('user');
  const user = userJson ? JSON.parse(userJson) : null;
  const userEmail = user?.email || '';
  const userId = user?.id || user?.email || '';

  const getDefaultPublishBy = () => {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    return d.toISOString().split('T')[0];
  };

  const {
    register,
    handleSubmit,
    formState: { errors },
    reset,
    setValue,
    getValues,
    trigger,
    watch,
  } = useForm<CommsRequestFormData>({
    resolver: zodResolver(commsRequestSchema),
    defaultValues: {
      email: userEmail,
      audience: [],
      urgentRequest: false,
      otherAudienceText: '',
      publishBy: getDefaultPublishBy(),
    },
  });

  const publishByValue = watch('publishBy');
  const audienceValue = watch('audience');
  const urgentRequestValue = watch('urgentRequest');

  // Auto-save draft on field changes (debounced 2s)
  const watchedValues = watch();
  useEffect(() => {
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
    draftTimerRef.current = setTimeout(() => {
      try {
        localStorage.setItem('commsRequestDraft', JSON.stringify({
          ...watchedValues,
          editorContent,
          selectedTemplateId,
        }));
      } catch { /* ignore quota errors */ }
    }, 2000);
    return () => { if (draftTimerRef.current) clearTimeout(draftTimerRef.current); };
  }, [watchedValues, editorContent, selectedTemplateId]);

  // Restore draft on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem('commsRequestDraft');
      if (saved) {
        const draft = JSON.parse(saved);
        Object.entries(draft).forEach(([key, value]) => {
          if (key === 'editorContent') {
            setEditorContent(value as string);
          } else if (key === 'selectedTemplateId') {
            setSelectedTemplateId(value as string | null);
          } else if (key === 'email') {
            // Always use current user's email, not stale draft value
            setValue('email', userEmail);
          } else if (key in commsRequestSchema.shape) {
            setValue(key as keyof CommsRequestFormData, value as any);
          }
        });
      }
    } catch { /* ignore parse errors */ }
  }, [setValue]);

  const getTomorrow = () => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(0, 0, 0, 0);
    return d;
  };

  const getOneWeekOut = () => {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    d.setHours(0, 0, 0, 0);
    return d;
  };

  const isDateInUrgentRange = (date: Date) => {
    const tomorrow = getTomorrow();
    const oneWeek = getOneWeekOut();
    return date >= tomorrow && date < oneWeek;
  };

  const getPublishByDateClassName = (date: Date) => {
    if (isDateInUrgentRange(date)) {
      return 'urgent-date';
    }
    return '';
  };

  const publishByDate = publishByValue ? new Date(publishByValue + 'T00:00:00') : null;

  // Auto-check urgent when selecting a date within the next week
  useEffect(() => {
    if (!publishByValue) return;
    const selected = new Date(publishByValue + 'T00:00:00');
    if (isDateInUrgentRange(selected) && !urgentRequestValue) {
      setValue('urgentRequest', true);
    }
  }, [publishByValue]);

  // When unchecking urgent, ensure date is at least a week out
  const handleUrgentChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const isChecked = e.target.checked;
    if (!isChecked && publishByValue) {
      const selected = new Date(publishByValue + 'T00:00:00');
      if (isDateInUrgentRange(selected)) {
        // Reset date to one week out
        setValue('publishBy', getDefaultPublishBy());
      }
    }
    setValue('urgentRequest', isChecked);
  };

  const [allUsers, setAllUsers] = useState<User[]>([]);
  const [councilManagers, setCouncilManagers] = useState<any[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const [approverEmails, setApproverEmails] = useState<string[]>(['']);
  const [skipApprovers, setSkipApprovers] = useState(false);
  const [suggestions, setSuggestions] = useState<{ [key: number]: User[] }>({});
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState<{ [key: number]: number }>({});

  useEffect(() => {
    const fetchUsers = async () => {
      try {
        const sessionId = localStorage.getItem('sessionId');
        if (!sessionId) return;

        const usersResponse = await fetch(`${API_URL}/user/approvers`, {
          headers: { Authorization: `Bearer ${sessionId}` },
        });
        if (!usersResponse.ok) throw new Error('Failed to fetch approvers');
        const usersData = await usersResponse.json();
        setAllUsers(usersData.users || []);

        const managersResponse = await fetch(`${API_URL}/council/members`, {
          headers: { Authorization: `Bearer ${sessionId}` },
        });
        if (!managersResponse.ok) throw new Error('Failed to fetch council managers');
        const managersData = await managersResponse.json();
        setCouncilManagers(managersData);
      } catch (error) {
        console.error('Error fetching users:', error);
      }
    };
    fetchUsers();
  }, []);

  const handleEditorChange = (_editor: any, json: string) => {
    setEditorContent(json);
    setValue('text', json);
  };

  const handleTemplateSelect = (template: any) => {
    if (!template) {
      setSelectedTemplateId(null);
      return;
    }
    setSelectedTemplateId(template.id);
    if (template.fields) {
      if (template.fields.audience) setValue('audience', template.fields.audience);
      if (template.fields.signatureText) setValue('signatureText', template.fields.signatureText);
      if (template.fields.suggestedSubjectLine) setValue('suggestedSubjectLine', template.fields.suggestedSubjectLine);
      if (template.fields.description) setValue('description', template.fields.description);
    }
  };

  const showCouncilManagerDefaults = (index: number) => {
    const cmUsers = allUsers.filter((u) =>
      councilManagers.some((m) => m.email === u.email)
    );
    if (cmUsers.length > 0) {
      setSuggestions((prev) => ({ ...prev, [index]: cmUsers }));
      setActiveSuggestionIndex((prev) => ({ ...prev, [index]: 0 }));
    }
  };

  const handleEmailChange = (index: number, value: string) => {
    const newEmails = [...approverEmails];
    newEmails[index] = value;
    setApproverEmails(newEmails);

    if (value && allUsers.length > 0) {
      const filtered = allUsers.filter(
        (u) =>
          u.email.toLowerCase().includes(value.toLowerCase()) ||
          (u.name && u.name.toLowerCase().includes(value.toLowerCase()))
      );
      setSuggestions((prev) => ({ ...prev, [index]: filtered }));
      setActiveSuggestionIndex((prev) => ({ ...prev, [index]: 0 }));
    } else if (!value) {
      showCouncilManagerDefaults(index);
    } else {
      setSuggestions((prev) => ({ ...prev, [index]: [] }));
      setActiveSuggestionIndex((prev) => ({ ...prev, [index]: 0 }));
    }
  };

  const handleSuggestionClick = async (index: number, email: string) => {
    const newEmails = [...approverEmails];
    newEmails[index] = email;
    setApproverEmails(newEmails);
    setSuggestions((prev) => ({ ...prev, [index]: [] }));

    const isCouncilManager = councilManagers.some((m) => m.email === email);
    if (!isCouncilManager) {
      try {
        const sessionId = localStorage.getItem('sessionId');
        if (!sessionId) return;
        const response = await fetch(`${API_URL}/admin/council-managers`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${sessionId}`,
          },
          body: JSON.stringify({ email, role: 'CommunicationsManager', action: 'add' }),
        });
        if (response.ok) {
          const managersResponse = await fetch(`${API_URL}/council/members`, {
            headers: { Authorization: `Bearer ${sessionId}` },
          });
          if (managersResponse.ok) {
            setCouncilManagers(await managersResponse.json());
          }
        }
      } catch (error) {
        console.error('Error updating council manager:', error);
      }
    }
  };

  const handleEmailKeyDown = (index: number, e: React.KeyboardEvent<any>) => {
    if (!suggestions[index] || suggestions[index].length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveSuggestionIndex((prev) => ({
        ...prev,
        [index]: Math.min((prev[index] ?? 0) + 1, suggestions[index].length - 1),
      }));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveSuggestionIndex((prev) => ({
        ...prev,
        [index]: Math.max((prev[index] ?? 0) - 1, 0),
      }));
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      const activeIdx = activeSuggestionIndex[index] ?? 0;
      if (suggestions[index][activeIdx]) {
        handleSuggestionClick(index, suggestions[index][activeIdx].email);
      }
    }
  };

  const addApproverField = () => setApproverEmails([...approverEmails, '']);

  const removeApproverField = (index: number) => {
    if (approverEmails.length === 1) return;
    setApproverEmails(approverEmails.filter((_, i) => i !== index));
    setSuggestions((prev) => {
      const next = { ...prev };
      delete next[index];
      return next;
    });
    setActiveSuggestionIndex((prev) => {
      const next = { ...prev };
      delete next[index];
      return next;
    });
  };

  // Step validation
  const validateStep = async (currentStep: number): Promise<boolean> => {
    setStepErrors([]);
    setFormError(null);

    if (currentStep === 1) {
      const fieldsToValidate: (keyof CommsRequestFormData)[] = [
        'description',
        'suggestedSubjectLine',
        'signatureText',
      ];
      const valid = await trigger(fieldsToValidate);
      if (!valid) setFormError('Please fill in all required fields before continuing.');
      return valid;
    }

    if (currentStep === 2) {
      const fieldsToValidate: (keyof CommsRequestFormData)[] = [
        'email',
        'replyToAddress',
        'owner',
        'publishBy',
        'audience',
      ];
      const valid = await trigger(fieldsToValidate);

      const currentAudience = getValues('audience') || [];
      if (currentAudience.includes('other')) {
        const otherText = getValues('otherAudienceText') || '';
        if (!otherText.trim()) {
          setFormError('Please describe your "Other" audience');
          return false;
        }
      }
      if (!valid) setFormError('Please fill in all required fields before continuing.');
      return valid;
    }

    return true;
  };

  const goNext = async () => {
    const valid = await validateStep(step);
    if (valid) {
      setFormError(null);
      setStep((s) => Math.min(s + 1, 3));
    }
  };

  const goBack = () => setStep((s) => Math.max(s - 1, 1));

  const onSubmit = async (data: CommsRequestFormData) => {
    try {
      const validApprovers = skipApprovers ? [] : approverEmails.filter((e) => e.trim() !== '');
      if (!skipApprovers && validApprovers.length === 0) {
        setFormError('Please add at least one approver, or select "I don\'t know who should approve this"');
        return;
      }

      const submission: Partial<ContentSubmission> = {
        id: crypto.randomUUID(),
        title: data.suggestedSubjectLine,
        content: data.text || '',
        richTextContent: editorContent,
        status: 'in_review',
        submittedBy: userId,
        submittedAt: new Date(),
        formFields: [
          { id: 'owner', label: 'Owner', value: data.owner, type: 'text', required: true },
          { id: 'publishBy', label: 'Publish By', value: data.publishBy, type: 'date', required: true },
          { id: 'urgentRequest', label: 'Urgent Request', value: data.urgentRequest ? 'Yes' : 'No', type: 'text', required: false },
          { id: 'audience', label: 'Audience', value: data.audience.map((a) =>
            a === 'other' && data.otherAudienceText ? `Other: ${data.otherAudienceText}` : AUDIENCE_LABELS[a] || a
          ).join(', '), type: 'text', required: true },
          { id: 'description', label: 'Description', value: data.description, type: 'text', required: true },
          { id: 'replyToAddress', label: 'Reply-To Address', value: data.replyToAddress, type: 'text', required: true },
          { id: 'signatureText', label: 'Signature Text', value: data.signatureText, type: 'text', required: true },
          { id: 'notes', label: 'Notes', value: data.notes || '', type: 'text', required: false },
        ],
        comments: [],
        approvals: [],
        changes: [],
        assignedReviewers: [],
        assignedCouncilManagers: [],
        requiredApprovers: validApprovers,
      };

      await saveSubmission(submission as ContentSubmission);
      localStorage.removeItem('commsRequestDraft');
      setShowSuccess(true);
      reset();
      setEditorContent('');
      setApproverEmails(['']);
      setSelectedTemplateId(null);
      setStep(1);
    } catch (error) {
      console.error('Error submitting form:', error);
    }
  };

  const handleViewSubmissions = () => {
    setShowSuccess(false);
    navigate('/requests');
  };

  const values = getValues();

  // --- Render helpers ---

  const renderStepper = () => (
    <div className="wizard-stepper">
      {STEPS.map((s, i) => (
        <React.Fragment key={s.number}>
          <div className="step-node">
            <div
              className={`step-circle ${step === s.number ? 'active' : ''} ${step > s.number ? 'completed' : ''}`}
            >
              {step > s.number ? '\u2713' : s.number}
            </div>
            <div
              className={`step-label ${step === s.number ? 'active' : ''} ${step > s.number ? 'completed' : ''}`}
            >
              {s.label}
            </div>
          </div>
          {i < STEPS.length - 1 && (
            <div className={`step-connector ${step > s.number ? 'completed' : ''}`} />
          )}
        </React.Fragment>
      ))}
    </div>
  );

  const renderStep1 = () => (
    <>
      <div className="wizard-card">
        <div className="wizard-card-header">
          <h3>Content</h3>
          <p>Describe what you need communicated and provide any draft text.</p>
        </div>

        <TemplatePicker
          selectedId={selectedTemplateId}
          onSelect={handleTemplateSelect}
        />

        <div className="form-field">
          <label>Suggested Subject Line <span className="required">*</span></label>
          <Form.Control
            type="text"
            {...register('suggestedSubjectLine')}
            placeholder="What should the subject line say?"
          />
          {errors.suggestedSubjectLine && (
            <div className="field-error">{errors.suggestedSubjectLine.message}</div>
          )}
        </div>

        <div className="form-field">
          <label>Description <span className="required">*</span></label>
          <Form.Control
            as="textarea"
            rows={3}
            {...register('description')}
            placeholder="Briefly describe the document this request is about"
          />
          {errors.description && <div className="field-error">{errors.description.message}</div>}
        </div>

        <div className="form-field">
          <label>Text</label>
          <div className="field-hint" style={{ marginBottom: 8 }}>
            Include any text you'd like us to use, or paste content and links here.
          </div>
          <LexicalEditorComponent
            initialContent={editorContent}
            onChange={handleEditorChange}
            placeholder="Start typing or paste your content..."
            className="h-64"
            currentUserId={userId}
          />
        </div>

        <div className="form-field">
          <label>Signature Text <span className="required">*</span></label>
          <Form.Control
            type="text"
            {...register('signatureText')}
            placeholder="What text do you want at the end of the email?"
          />
          {errors.signatureText && (
            <div className="field-error">{errors.signatureText.message}</div>
          )}
        </div>

        <div className="form-field" style={{ marginTop: 8 }}>
          <label>Notes</label>
          <Form.Control
            as="textarea"
            rows={2}
            {...register('notes')}
            placeholder="Notes, questions, issues, or anything else you want us to know"
          />
        </div>
      </div>
    </>
  );

  const renderStep2 = () => (
    <>
      <div className="wizard-card">
        <div className="wizard-card-header">
          <h3>Audience & Timing</h3>
          <p>Who should see this and when?</p>
        </div>

        <div className="form-field">
          <label>Audience <span className="required">*</span></label>
          <div className="audience-cards-grid">
            {AUDIENCE_CARDS.map((card) => {
              const checked = audienceValue?.includes(card.id) ?? false;
              return (
                <AudienceCard
                  key={card.id}
                  id={card.id}
                  label={card.label}
                  description={card.description}
                  icon={card.icon}
                  selected={checked}
                  onToggle={() => {
                    const current = audienceValue || [];
                    const next = checked
                      ? current.filter((v: string) => v !== card.id)
                      : [...current, card.id];
                    setValue('audience', next, { shouldValidate: true });
                  }}
                />
              );
            })}
          </div>
          {audienceValue?.includes('other') && (
            <div className="other-audience-field" style={{ marginTop: 8 }}>
              <Form.Control
                type="text"
                {...register('otherAudienceText')}
                placeholder="Please describe your audience..."
              />
            </div>
          )}
          {errors.audience && <div className="field-error">{errors.audience.message}</div>}
        </div>

        <div className="form-field">
          <label>Owner <span className="required">*</span></label>
          <Form.Control
            type="text"
            {...register('owner')}
            placeholder="Who owns this content?"
          />
          <div className="field-hint">Cadre, team, or individual responsible for accuracy</div>
          {errors.owner && <div className="field-error">{errors.owner.message}</div>}
        </div>

        <div className="form-field">
          <label
            className={`urgent-checkbox-label ${urgentRequestValue ? 'checked' : ''}`}
          >
            <input
              type="checkbox"
              checked={urgentRequestValue || false}
              onChange={handleUrgentChange}
            />
            <span>This is an urgent request</span>
          </label>
          {urgentRequestValue && (
            <div className="urgent-help-text">
              Is this an urgent request that will require less than a week's turnaround time?
              Please note that Comms might not always be able to meet last-minute requests.
              If you need a fast turnaround, please also send an email to{' '}
              <a href="mailto:ranger-comm-cadre-list@burningman.org">
                ranger-comm-cadre-list@burningman.org
              </a>{' '}
              to let us know, and please try to give us more notice next time. Thanks!
            </div>
          )}
        </div>

        <div className="form-field">
          <label>Publish By <span className="required">*</span></label>
          <DatePicker
            selected={publishByDate}
            onChange={(date: Date | null) => {
              if (date) {
                const iso = date.toISOString().split('T')[0];
                setValue('publishBy', iso, { shouldValidate: true });
              }
            }}
            minDate={getTomorrow()}
            dayClassName={(date: Date) => getPublishByDateClassName(date)}
            dateFormat="yyyy-MM-dd"
            className="form-control"
            placeholderText="Select a date"
          />
          <div className="field-hint">
            <span className="urgent-date-legend"></span> Dates within the next week are urgent
          </div>
          {errors.publishBy && <div className="field-error">{errors.publishBy.message}</div>}
        </div>

        <div className="form-row">
          <div className="form-field">
            <label>Email <span className="required">*</span></label>
            <Form.Control type="email" {...register('email')} readOnly />
          </div>
          <div className="form-field">
            <label>Reply-To Address <span className="required">*</span></label>
            <Form.Control
              type="email"
              {...register('replyToAddress')}
              placeholder="Who should recipients reply to?"
            />
            <div className="field-hint">Every announcement includes a reply-to address at the top, what should it be?</div>
            {errors.replyToAddress && (
              <div className="field-error">{errors.replyToAddress.message}</div>
            )}
          </div>
        </div>
      </div>
    </>
  );

  const renderStep3 = () => (
    <>
      <div className="wizard-card">
        <div className="wizard-card-header">
          <h3>Required Approvers</h3>
          <p>Add approvers who should review this request, or let Comms Cadre assign them later.</p>
        </div>

        <div className="form-field">
          <label
            className={`urgent-checkbox-label ${skipApprovers ? 'checked' : ''}`}
            style={skipApprovers ? { borderColor: 'var(--accent-teal)', background: 'rgba(61, 104, 105, 0.05)' } : {}}
          >
            <input
              type="checkbox"
              checked={skipApprovers}
              onChange={(e) => {
                setSkipApprovers(e.target.checked);
                if (e.target.checked) {
                  setApproverEmails(['']);
                  setFormError(null);
                }
              }}
              style={{ accentColor: 'var(--accent-teal)' }}
            />
            <span>I don't know who should approve this</span>
          </label>
          {skipApprovers && (
            <div className="field-hint" style={{ marginTop: 8 }}>
              No problem — Comms Cadre will assign approvers after submission.
            </div>
          )}
        </div>

        {!skipApprovers && (
          <>
            <div className="approver-list">
              {approverEmails.map((email, index) => {
                const items = suggestions[index] || [];
                const activeIdx = activeSuggestionIndex[index] ?? 0;
                const showDropdown = items.length > 0;

                return (
                  <div key={index} className="approver-row">
                    <div className="approver-input-wrap">
                      <Form.Control
                        type="email"
                        value={email}
                        onChange={(e) => handleEmailChange(index, e.target.value)}
                        onKeyDown={(e) => handleEmailKeyDown(index, e)}
                        onFocus={() => {
                          if (!email) showCouncilManagerDefaults(index);
                        }}
                        onBlur={() => {
                          setTimeout(() => {
                            setSuggestions((prev) => ({ ...prev, [index]: [] }));
                          }, 150);
                        }}
                        placeholder="Search by name or email..."
                        autoComplete="off"
                        spellCheck={false}
                      />
                      {showDropdown && (
                        <div className="approver-dropdown">
                          {items.slice(0, 6).map((u, i) => {
                            const isManager = councilManagers.some((m) => m.email === u.email);
                            return (
                              <div
                                key={u.email}
                                className={`approver-dropdown-item ${i === activeIdx ? 'active' : ''}`}
                                onMouseDown={(e) => {
                                  e.preventDefault();
                                  handleSuggestionClick(index, u.email);
                                }}
                              >
                                <div className="approver-dropdown-info">
                                  <span className="approver-dropdown-name">
                                    {u.name || u.email.split('@')[0]}
                                  </span>
                                  <span className="approver-dropdown-email">{u.email}</span>
                                </div>
                                {isManager && (
                                  <span className="approver-badge-cm">Council Manager</span>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                    {approverEmails.length > 1 && (
                      <button
                        type="button"
                        className="remove-approver-btn"
                        onClick={() => removeApproverField(index)}
                        title="Remove approver"
                      >
                        &times;
                      </button>
                    )}
                  </div>
                );
              })}
            </div>

            <button type="button" className="add-approver-btn" onClick={addApproverField}>
              + Add Approver
            </button>
          </>
        )}
      </div>
    </>
  );

  return (
    <div className="comms-wizard">
      <div className="wizard-intro">
        <h2>New Comms Request</h2>
        <p>
          Ranger Communications can write, edit, and help you get your message out.
        </p>
      </div>

      {renderStepper()}

      <div className={`wizard-body${step >= 2 ? ' has-sidebar' : ''}`}>
        <Form
          className="wizard-main"
          onSubmit={handleSubmit(
            (data) => onSubmit(data),
            () => {}
          )}
        >
          <div style={{ display: step === 1 ? undefined : 'none' }}>
            {renderStep1()}
          </div>
          <div style={{ display: step === 2 ? undefined : 'none' }}>
            {renderStep2()}
          </div>
          <div style={{ display: step === 3 ? undefined : 'none' }}>
            {renderStep3()}
          </div>

          {formError && (
            <div className="field-error" style={{ marginTop: 8, marginBottom: 8 }}>
              {formError}
            </div>
          )}

          <div className="wizard-nav">
            {step > 1 ? (
              <button type="button" className="btn-back" onClick={goBack}>
                Back
              </button>
            ) : (
              <div />
            )}

            {step < 3 ? (
              <button type="button" className="btn-next" onClick={goNext}>
                Next
              </button>
            ) : (
              <button type="submit" className="btn-submit">
                Submit Request
              </button>
            )}
          </div>
        </Form>

        {step >= 2 && (
          <FormSummarySidebar
            title={values.suggestedSubjectLine}
            description={values.description}
            audience={values.audience}
            audienceLabels={AUDIENCE_LABELS}
            publishBy={values.publishBy}
            urgent={values.urgentRequest}
            replyTo={values.replyToAddress}
            signature={values.signatureText}
            approvers={approverEmails}
            hasContent={!!editorContent}
          />
        )}
      </div>

      {showSuccess && (
        <div className="modal-overlay" onClick={() => setShowSuccess(false)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Request Submitted!</h3>
              <button className="modal-close" onClick={() => setShowSuccess(false)}>&times;</button>
            </div>
            <div className="modal-body">
              <p>Your comms request has been submitted and is now under review.</p>
              <p>You can track the status of your request in the submissions area.</p>
            </div>
            <div className="modal-footer">
              <button className="btn btn-neutral" onClick={() => setShowSuccess(false)}>Close</button>
              <button className="btn btn-primary" onClick={handleViewSubmissions}>View Submissions</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default CommsRequest;
