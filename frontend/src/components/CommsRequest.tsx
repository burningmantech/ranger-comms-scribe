import React, { useState } from 'react';
import { Form, Button, Alert } from 'react-bootstrap';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

// Define the form schema using Zod
const commsRequestSchema = z.object({
  email: z.string().email('Please enter a valid email address'),
  owner: z.string().min(1, 'Owner is required'),
  requiredApprovers: z.string().min(1, 'Required approvers are required'),
  publishBy: z.string().min(1, 'Publish date is required'),
  urgency: z.enum(['no', 'yes'], {
    required_error: 'Please select an urgency level',
  }),
  audience: z.string().min(1, 'Please select an audience'),
  description: z.string().min(1, 'Description is required'),
  suggestedSubjectLine: z.string().min(1, 'Subject line is required'),
  replyToAddress: z.string().email('Please enter a valid reply-to email address'),
  text: z.string().optional(),
  signatureText: z.string().min(1, 'Signature text is required'),
  notes: z.string().optional(),
});

type CommsRequestFormData = z.infer<typeof commsRequestSchema>;

const CommsRequest: React.FC = () => {
  const [showSuccess, setShowSuccess] = useState(false);
  
  const {
    register,
    handleSubmit,
    formState: { errors },
    reset,
  } = useForm<CommsRequestFormData>({
    resolver: zodResolver(commsRequestSchema),
    defaultValues: {
      email: 'ranger.helpdesk@burningman.org',
    },
  });

  const onSubmit = async (data: CommsRequestFormData) => {
    try {
      // TODO: Implement API call to submit the form
      console.log('Form submitted:', data);
      setShowSuccess(true);
      reset();
    } catch (error) {
      console.error('Error submitting form:', error);
    }
  };

  return (
    <div className="content-management">
      <div className="content-body">
        <h2>Comms Request</h2>
        <p className="mb-4">
          Ranger Communications can write, edit, facilitate and make your message heard. 
          We can help you tell the Rangers what you need them to know.
        </p>

        {showSuccess && (
          <Alert variant="success" onClose={() => setShowSuccess(false)} dismissible>
            Your comms request has been submitted successfully!
          </Alert>
        )}

        <Form onSubmit={handleSubmit(onSubmit)}>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Contact Information */}
            <div className="col-span-2">
              <h3 className="text-lg font-semibold mb-3">Contact Information</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Form.Group>
                  <Form.Label>Email *</Form.Label>
                  <Form.Control
                    type="email"
                    {...register('email')}
                    readOnly
                  />
                </Form.Group>

                <Form.Group>
                  <Form.Label>Reply-To Address *</Form.Label>
                  <Form.Control
                    type="email"
                    {...register('replyToAddress')}
                    placeholder="Who should recipients send their questions to?"
                  />
                  {errors.replyToAddress && (
                    <Form.Text className="text-danger">{errors.replyToAddress.message}</Form.Text>
                  )}
                </Form.Group>
              </div>
            </div>

            {/* Request Details */}
            <div className="col-span-2">
              <h3 className="text-lg font-semibold mb-3">Request Details</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Form.Group>
                  <Form.Label>Owner *</Form.Label>
                  <Form.Control
                    type="text"
                    {...register('owner')}
                    placeholder="Cadre, team, or individual responsible for making sure the content is accurate"
                  />
                  {errors.owner && (
                    <Form.Text className="text-danger">{errors.owner.message}</Form.Text>
                  )}
                </Form.Group>

                <Form.Group>
                  <Form.Label>Publish By *</Form.Label>
                  <Form.Control
                    type="date"
                    {...register('publishBy')}
                  />
                  {errors.publishBy && (
                    <Form.Text className="text-danger">{errors.publishBy.message}</Form.Text>
                  )}
                </Form.Group>

                <Form.Group>
                  <Form.Label>Urgency *</Form.Label>
                  <Form.Select {...register('urgency')}>
                    <option value="">Select urgency level</option>
                    <option value="no">No, it can be included in the monthly newsletter</option>
                    <option value="yes">Yes, this is urgent</option>
                  </Form.Select>
                  {errors.urgency && (
                    <Form.Text className="text-danger">{errors.urgency.message}</Form.Text>
                  )}
                </Form.Group>

                <Form.Group>
                  <Form.Label>Audience *</Form.Label>
                  <Form.Select {...register('audience')}>
                    <option value="">Select audience</option>
                    <option value="newsletter">Monthly-ish Newsletter (sent over Ranger Announce)</option>
                    <option value="urgent">More urgent announcement (sent over Ranger Announce)</option>
                    <option value="allcom">Allcom (Can include off topic things, as well as copies of department announcements)</option>
                    <option value="website_fix">Website - something on the web site is wrong</option>
                    <option value="website_add">Website - something needs to be added</option>
                    <option value="jrs">JRS/Event Ops/Other BMP Audience</option>
                    <option value="event">Let's plan an event</option>
                    <option value="other">Other</option>
                  </Form.Select>
                  {errors.audience && (
                    <Form.Text className="text-danger">{errors.audience.message}</Form.Text>
                  )}
                </Form.Group>
              </div>
            </div>

            {/* Content Information */}
            <div className="col-span-2">
              <h3 className="text-lg font-semibold mb-3">Content Information</h3>
              <div className="grid grid-cols-1 gap-4">
                <Form.Group>
                  <Form.Label>Description *</Form.Label>
                  <Form.Control
                    as="textarea"
                    rows={3}
                    {...register('description')}
                    placeholder="Briefly describe the document this request is about"
                  />
                  {errors.description && (
                    <Form.Text className="text-danger">{errors.description.message}</Form.Text>
                  )}
                </Form.Group>

                <Form.Group>
                  <Form.Label>Suggested Subject Line *</Form.Label>
                  <Form.Control
                    type="text"
                    {...register('suggestedSubjectLine')}
                    placeholder="What should the subject line say?"
                  />
                  {errors.suggestedSubjectLine && (
                    <Form.Text className="text-danger">{errors.suggestedSubjectLine.message}</Form.Text>
                  )}
                </Form.Group>

                <Form.Group>
                  <Form.Label>Text</Form.Label>
                  <Form.Control
                    as="textarea"
                    rows={5}
                    {...register('text')}
                    placeholder="Include any text you'd like us to use or paste content and links here"
                  />
                </Form.Group>

                <Form.Group>
                  <Form.Label>Signature Text *</Form.Label>
                  <Form.Control
                    type="text"
                    {...register('signatureText')}
                    placeholder="What text do you want at the end of the email?"
                  />
                  {errors.signatureText && (
                    <Form.Text className="text-danger">{errors.signatureText.message}</Form.Text>
                  )}
                </Form.Group>
              </div>
            </div>

            {/* Additional Information */}
            <div className="col-span-2">
              <h3 className="text-lg font-semibold mb-3">Additional Information</h3>
              <div className="grid grid-cols-1 gap-4">
                <Form.Group>
                  <Form.Label>Required Approvers *</Form.Label>
                  <Form.Control
                    as="textarea"
                    rows={3}
                    {...register('requiredApprovers')}
                    placeholder="Include email addresses of individual people who need to approve the content"
                  />
                  {errors.requiredApprovers && (
                    <Form.Text className="text-danger">{errors.requiredApprovers.message}</Form.Text>
                  )}
                </Form.Group>

                <Form.Group>
                  <Form.Label>Notes</Form.Label>
                  <Form.Control
                    as="textarea"
                    rows={3}
                    {...register('notes')}
                    placeholder="Notes, questions, issues, etc.; anything you want us to know about this project"
                  />
                </Form.Group>
              </div>
            </div>
          </div>

          <div className="mt-6 flex justify-end">
            <Button variant="primary" type="submit" className="submit-button">
              Submit Comms Request
            </Button>
          </div>
        </Form>
      </div>
    </div>
  );
};

export default CommsRequest; 