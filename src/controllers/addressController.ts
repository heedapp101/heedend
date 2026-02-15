import { Response } from "express";
import { AuthRequest } from "../middleware/authMiddleware.js";
import SavedAddress, { ISavedAddress } from "../models/SavedAddress.js";

const MAX_ADDRESSES = 5;

// GET /api/addresses - Get all saved addresses for current user
export const getSavedAddresses = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?._id;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const addresses = await SavedAddress.find({ user: userId })
      .sort({ isDefault: -1, updatedAt: -1 })
      .lean();

    return res.json({ addresses });
  } catch (error: any) {
    console.error("Get saved addresses error:", error);
    return res.status(500).json({ message: "Failed to fetch addresses" });
  }
};

// POST /api/addresses - Create a new saved address
export const createSavedAddress = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?._id;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    // Check limit
    const count = await SavedAddress.countDocuments({ user: userId });
    if (count >= MAX_ADDRESSES) {
      return res.status(400).json({
        message: `You can save up to ${MAX_ADDRESSES} addresses. Please delete one to add a new one.`,
      });
    }

    const {
      label,
      fullName,
      phone,
      addressLine1,
      addressLine2,
      city,
      state,
      pincode,
      landmark,
      isDefault,
    } = req.body;

    // Basic validation
    if (!fullName?.trim() || !phone?.trim() || !addressLine1?.trim() || !city?.trim() || !state?.trim() || !pincode?.trim()) {
      return res.status(400).json({ message: "Please fill all required fields" });
    }

    if (!/^[6-9]\d{9}$/.test(phone.trim())) {
      return res.status(400).json({ message: "Enter valid 10-digit phone number" });
    }

    if (!/^\d{6}$/.test(pincode.trim())) {
      return res.status(400).json({ message: "Enter valid 6-digit pincode" });
    }

    // If this is the first address, make it default
    const shouldBeDefault = isDefault || count === 0;

    const address = new SavedAddress({
      user: userId,
      label: label?.trim() || "Home",
      fullName: fullName.trim(),
      phone: phone.trim(),
      addressLine1: addressLine1.trim(),
      addressLine2: addressLine2?.trim() || "",
      city: city.trim(),
      state: state.trim(),
      pincode: pincode.trim(),
      landmark: landmark?.trim() || "",
      isDefault: shouldBeDefault,
    });

    await address.save();

    return res.status(201).json({ address, message: "Address saved successfully" });
  } catch (error: any) {
    console.error("Create saved address error:", error);
    return res.status(500).json({ message: "Failed to save address" });
  }
};

// PUT /api/addresses/:id - Update a saved address
export const updateSavedAddress = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?._id;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const { id } = req.params;
    const address = await SavedAddress.findOne({ _id: id, user: userId });
    if (!address) {
      return res.status(404).json({ message: "Address not found" });
    }

    const {
      label,
      fullName,
      phone,
      addressLine1,
      addressLine2,
      city,
      state,
      pincode,
      landmark,
      isDefault,
    } = req.body;

    if (fullName !== undefined) address.fullName = fullName.trim();
    if (phone !== undefined) {
      if (!/^[6-9]\d{9}$/.test(phone.trim())) {
        return res.status(400).json({ message: "Enter valid 10-digit phone number" });
      }
      address.phone = phone.trim();
    }
    if (addressLine1 !== undefined) address.addressLine1 = addressLine1.trim();
    if (addressLine2 !== undefined) address.addressLine2 = addressLine2.trim();
    if (city !== undefined) address.city = city.trim();
    if (state !== undefined) address.state = state.trim();
    if (pincode !== undefined) {
      if (!/^\d{6}$/.test(pincode.trim())) {
        return res.status(400).json({ message: "Enter valid 6-digit pincode" });
      }
      address.pincode = pincode.trim();
    }
    if (landmark !== undefined) address.landmark = landmark.trim();
    if (label !== undefined) address.label = label.trim();
    if (isDefault !== undefined) address.isDefault = isDefault;

    await address.save();

    return res.json({ address, message: "Address updated successfully" });
  } catch (error: any) {
    console.error("Update saved address error:", error);
    return res.status(500).json({ message: "Failed to update address" });
  }
};

// DELETE /api/addresses/:id - Delete a saved address
export const deleteSavedAddress = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?._id;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const { id } = req.params;
    const address = await SavedAddress.findOneAndDelete({ _id: id, user: userId }) as any;
    if (!address) {
      return res.status(404).json({ message: "Address not found" });
    }

    // If deleted address was default, make the most recent one default
    if (address.isDefault) {
      const latest = await SavedAddress.findOne({ user: userId }).sort({ updatedAt: -1 });
      if (latest) {
        latest.isDefault = true;
        await latest.save();
      }
    }

    return res.json({ message: "Address deleted successfully" });
  } catch (error: any) {
    console.error("Delete saved address error:", error);
    return res.status(500).json({ message: "Failed to delete address" });
  }
};

// PUT /api/addresses/:id/default - Set an address as default
export const setDefaultAddress = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?._id;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const { id } = req.params;
    const address = await SavedAddress.findOne({ _id: id, user: userId });
    if (!address) {
      return res.status(404).json({ message: "Address not found" });
    }

    address.isDefault = true;
    await address.save(); // pre-save hook will unset other defaults

    return res.json({ address, message: "Default address updated" });
  } catch (error: any) {
    console.error("Set default address error:", error);
    return res.status(500).json({ message: "Failed to set default address" });
  }
};
